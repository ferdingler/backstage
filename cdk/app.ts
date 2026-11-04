/**
 * Public audience site on Amplify Hosting, plus its firewall.
 *
 *   BackstagePublic   (us-west-2, the table's region): settings for the
 *                     console-created Amplify app (-c appId=...): builds web/
 *                     with `npm run build` (public-only: no host or agent
 *                     routes), and an SSR compute role that can only read and
 *                     write items in the existing Backstage table.
 *   BackstageFirewall (us-east-1, required by Amplify): AWS WAF web ACL that
 *                     allows only the public paths and rate-limits per IP and
 *                     in total, so traffic (and its bill) stays bounded.
 *
 * The table itself is created by web/scripts/create-table.mjs and is only
 * referenced here, so destroying these stacks never touches its data.
 */
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";

const app = new cdk.App();
const ctx = (key: string, fallback: string) =>
  String(app.node.tryGetContext(key) ?? fallback);

const account = process.env.CDK_DEFAULT_ACCOUNT;
const tableName = ctx("table", "backstage");
const tableRegion = ctx("tableRegion", "us-west-2");
const branch = ctx("branch", "main");
const appId = app.node.tryGetContext("appId") as string | undefined;
if (!appId || !/^d[a-z0-9]+$/.test(appId))
  throw new Error("Pass the console-created Amplify app: -c appId=d...");
// Requests per client IP, and in total, per 5-minute window. Each open
// audience page polls every 3 s (~100 requests / 5 min), and a venue NAT can
// put a whole room behind one IP.
const ipLimit = Number(ctx("ipLimit", "5000"));
const globalLimit = Number(ctx("globalLimit", "50000"));

class PublicStack extends cdk.Stack {
  readonly appArn: string;
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // What the public build does with DynamoDB: GetItem and Query for reads;
    // conditional Put/Delete inside TransactWriteItems for questions, votes and
    // visitor cookies. No Scan, BatchWrite (host-only reset), table management,
    // or any other AWS service.
    const role = new iam.Role(this, "ComputeRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Backstage public SSR: items in the Backstage table only.",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ],
        resources: [
          cdk.Arn.format(
            {
              service: "dynamodb",
              region: tableRegion,
              resource: "table",
              resourceName: tableName,
            },
            this,
          ),
        ],
      }),
    );

    // The app itself is created in the Amplify console, which connects GitHub
    // through the Amplify GitHub App (no token stored here). This stack then
    // owns its settings: compute role, build spec, variables, branch options.
    const appArn = cdk.Arn.format(
      { service: "amplify", resource: "apps", resourceName: appId },
      this,
    );
    const url = `https://${branch}.${appId}.amplifyapp.com`;
    const buildSpec = [
      "version: 1",
      "applications:",
      "  - appRoot: web",
      "    frontend:",
      "      phases:",
      "        preBuild:",
      "          commands:",
      "            - nvm install 22 && nvm use 22",
      "            - npm ci",
      "        build:",
      "          commands:",
      // Next.js reads runtime settings from .env.production on Amplify.
      "            - env | grep -E '^(BACKSTAGE_TABLE|AUDIENCE_URL|PUBLIC_ORIGINS|FORWARDED_HOPS)=' > .env.production",
      // Never ship the local build: it contains host and agent routes.
      "            - unset BACKSTAGE_BUILD && npm run build",
      "            - \"! grep -qE '\\\"/(host|api/host|api/agent)/' .next/app-path-routes-manifest.json\"",
      "      artifacts:",
      "        baseDirectory: .next",
      "        files:",
      "          - '**/*'",
      "      cache:",
      "        paths:",
      "          - node_modules/**/*",
    ].join("\n");
    const settings = (id: string, call: cr.AwsSdkCall) =>
      new cr.AwsCustomResource(this, id, {
        onCreate: call,
        onUpdate: call,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["amplify:UpdateApp", "amplify:UpdateBranch"],
            resources: [appArn, `${appArn}/branches/${branch}`],
          }),
          new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [role.roleArn],
          }),
        ]),
      });
    settings("AppSettings", {
      service: "Amplify",
      action: "updateApp",
      parameters: {
        appId,
        platform: "WEB_COMPUTE",
        computeRoleArn: role.roleArn,
        buildSpec,
        enableAutoBranchCreation: false,
        environmentVariables: {
          AMPLIFY_MONOREPO_APP_ROOT: "web",
          BACKSTAGE_TABLE: tableName,
          FORWARDED_HOPS: "1",
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${appId}-app`),
    });
    settings("BranchSettings", {
      service: "Amplify",
      action: "updateBranch",
      parameters: {
        appId,
        branchName: branch,
        stage: "PRODUCTION",
        framework: "Next.js - SSR",
        enableAutoBuild: true,
        // Preview builds would publish unreviewed branches on public URLs.
        enablePullRequestPreview: false,
        environmentVariables: { AUDIENCE_URL: url, PUBLIC_ORIGINS: url },
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${appId}-${branch}`),
    });

    this.appArn = appArn;
    new cdk.CfnOutput(this, "AudienceUrl", { value: url });
  }
}

class FirewallStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { appArn: string },
  ) {
    super(scope, id, props);
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: true,
    });
    // The same allowlist as web/routes.json's public pages and API, plus
    // Next.js static assets. Anything else is blocked before reaching compute.
    const publicPaths = new wafv2.CfnRegexPatternSet(this, "PublicPaths", {
      scope: "CLOUDFRONT",
      regularExpressionList: [
        "^/(broadcast|favicon\\.ico)?$",
        "^/api/(state|broadcast|health|questions|votes)$",
        "^/_next/static/[A-Za-z0-9._~/-]+$",
      ],
    });
    const acl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: visibility("backstage"),
      rules: [
        {
          name: "only-public-paths",
          priority: 0,
          action: { block: {} },
          visibilityConfig: visibility("backstage-paths"),
          statement: {
            notStatement: {
              statement: {
                regexPatternSetReferenceStatement: {
                  arn: publicPaths.attrArn,
                  fieldToMatch: { uriPath: {} },
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
        },
        {
          name: "per-ip-rate",
          priority: 1,
          action: { block: {} },
          visibilityConfig: visibility("backstage-ip-rate"),
          statement: {
            rateBasedStatement: { aggregateKeyType: "IP", limit: ipLimit },
          },
        },
        {
          name: "global-rate",
          priority: 2,
          action: { block: {} },
          visibilityConfig: visibility("backstage-global-rate"),
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "CONSTANT",
              limit: globalLimit,
              // CONSTANT needs a scope-down; this one matches every request.
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
        },
        {
          name: "aws-ip-reputation",
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: visibility("backstage-ip-reputation"),
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "Association", {
      resourceArn: props.appArn,
      webAclArn: acl.attrArn,
    });
  }
}

const site = new PublicStack(app, "BackstagePublic", {
  env: { account, region: tableRegion },
  crossRegionReferences: true,
});
new FirewallStack(app, "BackstageFirewall", {
  env: { account, region: "us-east-1" },
  crossRegionReferences: true,
  appArn: site.appArn,
});

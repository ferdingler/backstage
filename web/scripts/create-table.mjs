// Creates the Backstage DynamoDB table if it does not exist yet:
// on-demand capacity, deletion protection, point-in-time recovery, and TTL on `ttl`.
// Uses the AWS SDK credential chain (AWS_PROFILE, AWS_REGION) and BACKSTAGE_TABLE.
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

const TableName = process.env.BACKSTAGE_TABLE || "backstage";
const client = new DynamoDBClient(
  process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {},
);
const local = !!process.env.DYNAMODB_ENDPOINT;

try {
  await client.send(new DescribeTableCommand({ TableName }));
  console.log(`Table ${TableName} already exists.`);
} catch (error) {
  if (error.name !== "ResourceNotFoundException") throw error;
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      ...(local ? {} : { DeletionProtectionEnabled: true }),
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName });
  console.log(`Created table ${TableName}.`);
}
await client.send(
  new UpdateTimeToLiveCommand({
    TableName,
    TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
  }),
).catch((error) => {
  // Enabling TTL twice is rejected; it is already on.
  if (!/already enabled/i.test(error.message)) throw error;
});
if (!local)
  await client.send(
    new UpdateContinuousBackupsCommand({
      TableName,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }),
  );
console.log(`Table ${TableName} is ready.`);

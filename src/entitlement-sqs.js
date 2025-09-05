const AWS = require('aws-sdk');
const { NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region } = process.env;
// MarketplaceEntitlementService is instantianise only in the us-east-1 https://docs.aws.amazon.com/general/latest/gr/aws-marketplace.html#marketplaceentitlement
// const marketplaceEntitlementService = new AWS.MarketplaceEntitlementService({ apiVersion: '2017-01-11', region: 'us-east-1' });
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require("@aws-sdk/client-marketplace-entitlement-service");


async function getEntitlements(productCode, customerIdentifier, customerAccountId, region) {
  try {
    const filter = customerAccountId 
      ? { CUSTOMER_AWS_ACCOUNT_ID: [customerAccountId] }
      : { CUSTOMER_IDENTIFIER: [customerIdentifier] };

    const entitlementParams = {
      ProductCode: productCode,
      Filter: filter
    };
    console.log('entitlementParams:', JSON.stringify(entitlementParams, null, 2));

    const mpClient = new MarketplaceEntitlementServiceClient({ region });
    const command = new GetEntitlementsCommand(entitlementParams);
    return await mpClient.send(command);
  } catch (error) {
    console.error('Error getting entitlements:', error);
    return null;
  }
}


exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event, null, 2));
  await Promise.all(event.Records.map(async (record) => {
    const { body } = record;
    let { Message: message } = JSON.parse(body);

    if (typeof message === 'string' || message instanceof String) {
      message = JSON.parse(message);
    }
    console.log(`message: ${JSON.stringify(message, null, 2)}`);

    if (message.action === 'entitlement-updated') {
      let customerIdentifier = null;
      let customerAwsAccountId = null;
      if ('customer-aws-account-id' in message) {
        customerIdentifier = message['customer-aws-account-id'];
      } else {
        console.log('customer-aws-account-id not found in message, will use customer-identifier (DEPRECATION March 2026) instead');
        customerIdentifier = message['customer-identifier'];
      }

      const entitlementsResponse = await getEntitlements(
        message['product-code'], 
        customerIdentifier,
        customerAwsAccountId,
        aws_region
      );

      console.log(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);

      const isExpired = entitlementsResponse.hasOwnProperty("Entitlements") === false || entitlementsResponse.Entitlements.length === 0 || 
        new Date(entitlementsResponse.Entitlements[0].ExpirationDate) < new Date();
      console.log('isExpired', isExpired);

      if ('CustomerAWSAccountId' in entitlementsResponse.Entitlements[0]) {
        console.log('CustomerAWSAccountId found in entitlementsResponse, will use it instead of customer-identifier (DEPRECATION March 2026) instead');
        customerIdentifier = entitlementsResponse.Entitlements[0].CustomerAWSAccountId;
      }

      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: customerIdentifier },
        },
        UpdateExpression: 'set entitlement = :e, successfully_subscribed = :ss, subscription_expired = :se',
        ExpressionAttributeValues: {
          ':e': { S: JSON.stringify(entitlementsResponse) },
          ':ss': { BOOL: true },
          ':se': { BOOL: isExpired },
        },
        ReturnValues: 'UPDATED_NEW',
      };

      console.log(`dynamoDbParams: ${JSON.stringify(dynamoDbParams, null, 2)}`);
      await dynamodb.updateItem(dynamoDbParams).promise();
      console.log('Successfully updated entitlement');
    } else {
      console.error('Unhandled action');
      throw new Error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }
  }));
  return {};
};

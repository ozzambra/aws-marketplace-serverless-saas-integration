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
    
    const body = JSON.parse(record.body);
    console.log('body:', body, typeof body);
    const detailType = body['detail-type'];

    console.log('Detail Type:', detailType);   // License Updated - Manufacturer

    if (detailType === 'License Updated - Manufacturer') {
      console.log('Handling detail-type:', detailType);

      const productId = body.detail.product.id;
      const productCode = body.detail.product.code;
      const licenseId = body.detail.license.id;
      const customerAwsAccountId = body.detail.acceptor.accountId;
      console.log('productId:', productId);
      console.log('productCode:', productCode);
      console.log('licenseId:', licenseId);
      console.log('customerAwsAccountId:', customerAwsAccountId);

      const entitlementsResponse = await getEntitlements(
        productCode, 
        null,
        customerAwsAccountId,
        aws_region
      );

      console.log(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);
      const { $metadata, ...entitlementData } = entitlementsResponse;
      console.log(`entitlementData: ${JSON.stringify(entitlementData, null, 2)}`);
      const isExpired = entitlementData.hasOwnProperty("Entitlements") === false || entitlementData.Entitlements.length === 0 || 
        new Date(entitlementData.Entitlements[0].ExpirationDate) < new Date();
      console.log('isExpired', isExpired);

      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: licenseId },
        },
        UpdateExpression: 'set entitlement = :e, successfully_subscribed = :ss, subscription_expired = :se',
        ExpressionAttributeValues: {
          ':e': { S: JSON.stringify(entitlementData) },
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

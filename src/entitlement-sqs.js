const winston = require('winston');
const AWS = require('aws-sdk');
const { NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region } = process.env;
// MarketplaceEntitlementService is instantianise only in the us-east-1 https://docs.aws.amazon.com/general/latest/gr/aws-marketplace.html#marketplaceentitlement
// const marketplaceEntitlementService = new AWS.MarketplaceEntitlementService({ apiVersion: '2017-01-11', region: 'us-east-1' });
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require("@aws-sdk/client-marketplace-entitlement-service");
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});


async function getEntitlements(productCode, customerAccountId, region) {
  try {
    logger.info(`getEntitlements: productCode: ${productCode}, customerAccountId: ${customerAccountId}, region: ${region}`);
    const entitlementParams = {
      ProductCode: productCode,
      Filter: [customerAccountId]
    };
    logger.debug('entitlementParams:', JSON.stringify(entitlementParams, null, 2));

    const mpClient = new MarketplaceEntitlementServiceClient({ region });
    const command = new GetEntitlementsCommand(entitlementParams);
    return await mpClient.send(command);
  } catch (error) {
    logger.error('Error getting entitlements:', error);
    return null;
  }
}


exports.handler = async (event) => {
  logger.info('event:', JSON.stringify(event, null, 2));
  await Promise.all(event.Records.map(async (record) => {
    
    const body = JSON.parse(record.body);
    logger.debug('body:', body);
    const detailType = body['detail-type'];

    logger.debug('Detail Type:', detailType);   // License Updated - Manufacturer

    if (detailType === 'License Updated - Manufacturer' || detailType === 'License Deprovisioned - Manufacturer') {
      logger.debug('Handling detail-type:', detailType);

      const productId = body.detail.product.id;
      const productCode = body.detail.product.code;
      const licenseId = body.detail.license.id;
      const customerAwsAccountId = body.detail.acceptor.accountId;
      logger.debug('productId:', productId);
      logger.debug('productCode:', productCode);
      logger.debug('licenseId:', licenseId);
      logger.debug('customerAwsAccountId:', customerAwsAccountId);

      const entitlementsResponse = await getEntitlements(
        productCode, 
        customerAwsAccountId,
        aws_region
      );

      logger.debug(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);
      const { $metadata, ...entitlementData } = entitlementsResponse;
      logger.debug(`entitlementData: ${JSON.stringify(entitlementData, null, 2)}`);
      const isExpired = entitlementData.hasOwnProperty("Entitlements") === false || entitlementData.Entitlements.length === 0 || 
        new Date(entitlementData.Entitlements[0].ExpirationDate) < new Date();
      logger.debug('isExpired', isExpired);

      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: licenseId },
        },
        UpdateExpression: 'set entitlement = :e, successfully_subscribed = :ss, subscription_expired = :se, updated_at = :ua',
        ExpressionAttributeValues: {
          ':e': { S: JSON.stringify(entitlementData) },
          ':ss': { BOOL: true },
          ':se': { BOOL: isExpired },
          ':ua': { S: new Date().toISOString() },
        },
        ReturnValues: 'UPDATED_NEW',
      };

      logger.debug(`dynamoDbParams: ${JSON.stringify(dynamoDbParams, null, 2)}`);
      await dynamodb.updateItem(dynamoDbParams).promise();
      console.info('Successfully updated entitlement');
    } else {
      logger.error('Unhandled action');
      throw new Error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }
  }));
  return {};
};

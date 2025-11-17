const winston = require('winston');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require('@aws-sdk/client-marketplace-entitlement-service');
//const { MarketplaceAgreementServiceClient, DescribeAgreementCommand } = require('@aws-sdk/client-marketplace-agreement');
const { MarketplaceAgreementClient, DescribeAgreementCommand } = require('@aws-sdk/client-marketplace-agreement');
const { NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region, PricingModel: pricingModel } = process.env;
// MarketplaceEntitlementService is instantiated only in us-east-1 https://docs.aws.amazon.com/general/latest/gr/aws-marketplace.html#marketplaceentitlement
const dynamodb = new DynamoDBClient({ region: aws_region });
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

async function getAgreementDetails(agreementId) {
  try {
    logger.info(`getAgreementDetails: agreementId: ${agreementId}`);
    const agreementClient = new MarketplaceAgreementClient({ region: 'us-east-1' });
    const command = new DescribeAgreementCommand({
      agreementId: agreementId
    });
    const response = await agreementClient.send(command);
    logger.debug(`agreementResponse: ${JSON.stringify(response, null, 2)}`);
    return response;
  } catch (error) {
    logger.error(`Error getting agreement details for ${agreementId}:`, error);
    return null;
  }
}

function checkForFreeTrial(agreementDetails) {
  if (!agreementDetails || !agreementDetails.AcceptanceTerms) {
    return false;
  }
  
  // Check if any of the acceptance terms contain a free trial
  for (const term of agreementDetails.AcceptanceTerms) {
    if (term.FreeTrialPricingTerm) {
      logger.info('Free trial term found in agreement');
      return true;
    }
  }
  
  return false;
}


exports.handler = async (event) => {
  logger.info('event:', event);
  await Promise.all(event.Records.map(async (record) => {
    
    const body = JSON.parse(record.body);
    logger.debug('body:', body);
    const detailType = body['detail-type'];

    logger.debug(`Detail Type: ${detailType}`);   // License Updated - Manufacturer

    if (detailType === 'License Updated - Manufacturer' 
        || detailType === 'License Deprovisioned - Manufacturer' 
        || detailType === 'License Updated - Proposer' 
        || detailType === 'License Deprovisioned - Proposer') {
      logger.debug(`processing detail-type: ${detailType}`);

      const productId = body.detail.product.id;
      const productCode = body.detail.product.code;
      const licenseId = body.detail.license.id;
      const acceptorAccountId = body.detail.acceptor.accountId;
      const agreementId = body.detail.agreement.id;
      logger.debug(`productId: ${productId}`);
      logger.debug(`productCode: ${productCode}`);
      logger.debug(`licenseId: ${licenseId}`);
      logger.debug(`acceptorAccountId: ${acceptorAccountId}`);
      logger.debug(`agreementId: ${agreementId}`);

      // Fetch agreement details to check for free trial
      const agreementDetails = await getAgreementDetails(agreementId);
      const isFreeTrialTermPresent = checkForFreeTrial(agreementDetails);
      logger.info(`is_free_trial_term_present: ${isFreeTrialTermPresent}`);

      let entitlementData = {};
      let isExpired = detailType === 'License Deprovisioned - Manufacturer' || detailType === 'License Deprovisioned - Proposer';
      let updateExpression = ""

      // Only call GetEntitlements for contract-based pricing models
      if (pricingModel !== 'subscriptions') {
        const entitlementsResponse = await getEntitlements(
          productCode, 
          acceptorAccountId,
          aws_region
        );

        logger.debug(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);
        const { $metadata, ...data } = entitlementsResponse;
        entitlementData = data;
        logger.debug(`entitlementData: ${JSON.stringify(entitlementData, null, 2)}`);
        isExpired = entitlementData.hasOwnProperty("Entitlements") === false || entitlementData.Entitlements.length === 0 || 
          new Date(entitlementData.Entitlements[0].ExpirationDate) < new Date();
        logger.debug(`isExpired: ${isExpired}`);
        updateExpression= "set entitlement = :e, successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft, updated_at = :ua";
      } else {
        updateExpression= "set successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft, updated_at = :ua";
        logger.info('Skipping GetEntitlements call for subscriptions pricing model');
      }
      logger.debug(`updateExpression: ${updateExpression}`);

      const dynamoDbKey = acceptorAccountId;
      
      // Build ExpressionAttributeValues based on pricing model
      const expressionAttributeValues = {
        ':ss': { BOOL: true },
        ':se': { BOOL: isExpired },
        ':ft': { BOOL: isFreeTrialTermPresent },
        ':ua': { S: new Date().toISOString() },
      };
      
      // Only include entitlement data for contract-based pricing models
      if (pricingModel !== 'subscriptions') {
        expressionAttributeValues[':e'] = { S: JSON.stringify(entitlementData) };
      }

      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: dynamoDbKey },
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'UPDATED_NEW',
      };

      logger.debug(`dynamoDbParams: ${JSON.stringify(dynamoDbParams, null, 2)}`);
      await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
      logger.info(`License Agreement updated successfully in DynamoDB table ${newSubscribersTableName}`);
    } else {
      //logger.error('Unhandled action');
      logger.error(`Unhandled action - msg: ${JSON.stringify(record)}`);
      //throw new Error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }
  }));
  return {};
};

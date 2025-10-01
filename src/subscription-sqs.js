const winston = require('winston');
const AWS = require('aws-sdk');
const { SupportSNSArn: TopicArn, NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region } = process.env;
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const SNS = new AWS.SNS({ apiVersion: '2010-03-31' });
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


exports.SQSHandler = async (event) => {
  logger.info('event:', JSON.stringify(event, null, 2));
  await Promise.all(event.Records.map(async (record) => {
    const { body } = record;
    let { Message: message } = JSON.parse(body);

    if (typeof message === 'string' || message instanceof String) {
      message = JSON.parse(message);
    }
    logger.info(`message: ${JSON.stringify(message, null, 2)}`);

    let successfullySubscribed = false;
    let subscriptionExpired = false;

    // subscribe-success - License Updated (entitlement-sqs.js)
    // update entitlement-sqs.js to make DDB entry
    if (message.action === 'subscribe-success') {
      successfullySubscribed = true;
    //  Purchase Agreement Ended / Status TERMINATED
    } else if (message.action === 'unsubscribe-pending') {
      logger.info(`unsubscribe-pending: sending message to topic ${TopicArn}`);
      const SNSparams = {
        TopicArn,
        Subject: 'unsubscribe pending',
        Message: `unsubscribe pending: ${JSON.stringify(message)}`,
      };

      await SNS.publish(SNSparams).promise();
    } else if (message.action === 'subscribe-fail') {
      logger.info(`subscribe-fail: sending message to topic ${TopicArn}`);
      const SNSparams = {
        TopicArn,
        Subject: 'AWS Marketplace Subscription failed',
        Message: `Subscription failed: ${JSON.stringify(message)}`,
      };

      await SNS.publish(SNSparams).promise();
    } else if (message.action === 'unsubscribe-success') {
      subscriptionExpired = true;
    } else {
      logger.error('Unhandled action');
      throw new Error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }

    let isFreeTrialTermPresent = false;
    if (typeof message.isFreeTrialTermPresent === "string")  {
     isFreeTrialTermPresent = message.isFreeTrialTermPresent.toLowerCase() === "true";
    }

    let dynamoDbKey = message['customer-identifier']

    if (!message['customer-aws-account-id']) {
      logger.error('customer-aws-account-id not found in message. Trying GetEntitlements');

      const entitlementsResponse = await getEntitlements(
        message['product-code'], 
        message['customer-aws-account-id'],
        aws_region
      );
      
      if (entitlementsResponse) {
        logger.debug(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);
        
        if (entitlementsResponse.Entitlements[0]?.CustomerAWSAccountId) {
          logger.debug('CustomerAWSAccountId found in entitlementsResponse, will use it instead of customer-identifier (DEPRECATION March 2026) instead');
          dynamoDbKey = entitlementsResponse.Entitlements[0].CustomerAWSAccountId;
        }
      }
    }

    const dynamoDbParams = {
      TableName: newSubscribersTableName,
      Key: {
        customerIdentifier: { S: dynamoDbKey },
      },
      UpdateExpression: 'set subscription_action = :ac, successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft',
      ExpressionAttributeValues: {
        ':ac': { S: message['action'] },
        ':ss': { BOOL: successfullySubscribed },
        ':se': { BOOL: subscriptionExpired },
        ':ft': { BOOL: isFreeTrialTermPresent}
      },
      ReturnValues: 'UPDATED_NEW',
    };

    logger.debug(`updating dynamodb with params: ${JSON.stringify(dynamoDbParams, null, 2)}`);
    await dynamodb.updateItem(dynamoDbParams).promise();
    logger.info('dynamodb updated');
  }));
};

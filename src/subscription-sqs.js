const winston = require('winston');
const AWS = require('aws-sdk');
const { SupportSNSArn: TopicArn, NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region } = process.env;
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const SNS = new AWS.SNS({ apiVersion: '2010-03-31' });
const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require("@aws-sdk/client-marketplace-entitlement-service");
const { MarketplaceCatalogClient, DescribeEntityCommand } = require('@aws-sdk/client-marketplace-catalog');
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
  logger.info('SQSHandler event:', event);
  //console.log('console event:', event);
  await Promise.all(event.Records.map(async (record) => {
    const { body } = record;
    logger.info(`body: ${body}`);
    //console.log('body:', body);
    //console.log('typeof body:', typeof body);

    const message = typeof body === 'string' ? JSON.parse(body) : body;

    //let { Message: message } = JSON.parse(body);
    //console.log('message:', message);

    //if (typeof message === 'string' || message instanceof String) {
    //  message = JSON.parse(message);
    //}
    //console.log('message:', message);

    logger.info(`message: ${JSON.stringify(message, message, 2)}`);
    let successfullySubscribed = false;
    let subscriptionExpired = false;

    // subscribe-success - License Updated (entitlement-sqs.js)
    // update entitlement-sqs.js to make DDB entry
    //console.log('message.detail-type:', message['detail-type']);
    logger.info(`message.detail-type: ${message['detail-type']}`);

    if (message['detail-type']?.startsWith('Purchase Agreement Ended')) {
      // get status CANCELLED | EXPIRED | RENEWED | REPLACED | TERMINATED
      let agreementId = null;
      let agreementStatus = null;
      try {
        agreementId = message.detail.agreement.id;
        agreementStatus = message.detail.agreement.status;
        logger.info(`agreementId: ${agreementId} agreementStatus: ${agreementStatus}`);
      } catch (e) {
        logger.error('Error getting agreementId and agreementStatus:', e);
        return;
      }

      if (!agreementStatus) {
        logger.error('could not find agreementStatus');
        return;
      }

      // TERMINATED == subscribe-fail
      if (agreementStatus === 'TERMINATED') {
        logger.info(`agreementId "${agreementId}" ${agreementStatus} (subscribe-fail): sending message to topic ${TopicArn}`);
        const SNSparams = {
          TopicArn,
          Subject: `AWS Marketplace Agreement "${agreementId}" status "${agreementStatus}"`,
          Message: `Subscription failed: ${JSON.stringify(message)}`,
        };
        await SNS.publish(SNSparams).promise();
      } else if (['CANCELLED', 'EXPIRED'].includes(agreementStatus)) {
        // Cancelled, Expired) // metering records can still be send for 1 hour after receiving this event. Sending this events for Replaced, Renewed cases will be net new
        logger.info(`agreementId "${agreementId}" ${agreementStatus}: sending message to topic ${TopicArn}`);
        const isoString = new Date().toISOString();
        const SNSparams = {
          TopicArn,
          Subject: `AWS Marketplace Agreement "${agreementId}" status "${agreementStatus}"`,
          Message: `Subscription ended. You have 1h from ${isoString} to send metering records: ${JSON.stringify(message)}`,
        };
        await SNS.publish(SNSparams).promise();
      } else {
        logger.info(`status "${agreementStatus}" currently not handled`);
      }

    } else if (message['detail-type']?.startsWith('Purchase Agreement Created')) {
      // subscribe-success is equal to License updated
      // must go into entitlement
      //if (message.action === 'subscribe-success') {
      //console.log(`DETAILPURCHASE: {message['detail-type']}`);
      successfullySubscribed = true;
      //  Purchase Agreement Ended / Status TERMINATED
      // 'Purchase Agreement Ended - Proposer'
      //} else if (message.action === 'unsubscribe-pending') {
    } else if (message.action === 'subscribe-fail') {
      // Purchase Agreement Ended - Status TERMINATED
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

    let acceptorAccountId;
    if (message['detail']['acceptor']['accountId']) {
      acceptorAccountId = message['detail']['acceptor']['accountId'];
      logger.info(`acceptorAccountId: ${acceptorAccountId}`);
    }
    let offerId;
    let productId;
    let productCode;
    if (message['detail']['offer']['id']) {
      offerId = message['detail']['offer']['id'];
      logger.info(`offerId: ${offerId}`);
      const mpCatClient = new MarketplaceCatalogClient();

      const responseOfferId = await mpCatClient.send(new DescribeEntityCommand({
        Catalog: 'AWSMarketplace',
        EntityId: offerId
      }));
      logger.info(`responseOfferId: ${JSON.stringify(responseOfferId, null, 2)}`);
      productId = responseOfferId['DetailsDocument']['ProductId'];
      logger.info(`productId: ${productId}`);

      let responseProductId;
      try {
        responseProductId = await mpCatClient.send(new DescribeEntityCommand({
          Catalog: 'AWSMarketplace',
          EntityId: productId
        }));
      } catch (error) {
        logger.error('Error getting product details:', error);
        return;
      }
      logger.info(`responseProductId: ${JSON.stringify(responseProductId, null, 2)}`);
      productCode = responseProductId['DetailsDocument']['Description']['ProductCode'];
      logger.info(`productCode: ${productCode}`);
      logger.info(`all product information together: offerId: ${offerId} productId: ${productId} productCode: ${productCode}`);
      //const productCode = details.ProductCode;
    }

    //let dynamoDbKey = message['customer-identifier']
    let dynamoDbKey = acceptorAccountId

    //if (!message['customer-aws-account-id']) {
    if (!acceptorAccountId) {
      logger.error('customer-aws-account-id not found in message. Trying GetEntitlements');

      const entitlementsResponse = await getEntitlements(
        //message['product-code'],
        productCode,
        acceptorAccountId,
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
        ':ac': { S: message['detail-type'] },
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

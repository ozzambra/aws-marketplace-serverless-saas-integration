const winston = require('winston');
const AWS = require('aws-sdk');
const { SupportSNSArn: TopicArn, NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region } = process.env;
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const SNS = new AWS.SNS({ apiVersion: '2010-03-31' });
//const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require("@aws-sdk/client-marketplace-entitlement-service");
const { MarketplaceCatalogClient, DescribeEntityCommand } = require('@aws-sdk/client-marketplace-catalog');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

// publish message to SNS topic
async function publishSNS(subject, message) {
  const SNSparams = {
    TopicArn,
    Subject: subject,
    Message: message,
  };
  await SNS.publish(SNSparams).promise();
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

    logger.info(`message: ${JSON.stringify(message, message, 2)}`);
    let successfullySubscribed = false;
    let subscriptionExpired = false;

    // subscribe-success - License Updated (entitlement-sqs.js)

    // handle detail-type
    logger.info(`message.detail-type: ${message['detail-type']}`);

    //agreement data
    let agreementId = null;
    let agreementStatus = null;
    try {
      agreementId = message.detail.agreement.id;
      agreementStatus = message.detail.agreement.status;
      logger.info(`agreementId: ${agreementId} agreementStatus: ${agreementStatus}`);
    } catch (e) {
      logger.error('Error getting agreementId or agreementStatus:', e);
      return;
    }

    if (!agreementStatus) {
      logger.error('could not find agreementStatus');
      return;
    }

    if (message['detail-type']?.startsWith('Purchase Agreement Created')) {
      // Agreement Created
      successfullySubscribed = true;
      const isoString = new Date().toISOString();
      await publishSNS(
        `AWS Marketplace Agreement created: "${agreementId}" status "${agreementStatus}"`,
        `Agreement created: ${JSON.stringify(message)}`
      );

    } else if (message['detail-type']?.startsWith('Purchase Agreement Amended')) {
      // Agreement Amended
      const isoString = new Date().toISOString();
      await publishSNS(
        `AWS Marketplace Agreement amended: "${agreementId}" status "${agreementStatus}"`,
        `Agreement amended: ${JSON.stringify(message)}`
      );
    } else if (message['detail-type']?.startsWith('Purchase Agreement Ended')) {
      // Agreement Ended
      // ISV's (CPPO) want to recieve notification
      // when purchase agreements is upgraded
      // get status CANCELLED | EXPIRED | RENEWED | REPLACED | TERMINATED

      if (agreementStatus === 'TERMINATED') {
        //  Purchase Agreement Ended / Status TERMINATED (subscribe-fail)
        subscriptionExpired = true;
        logger.info(`agreementId "${agreementId}" ${agreementStatus} (subscribe-fail): sending message to topic ${TopicArn}`);
        const isoString = new Date().toISOString();
        await publishSNS(
          `AWS Marketplace Agreement "${agreementId}" status "${agreementStatus}"`,
          `Agreement terminated ${isoString}: ${JSON.stringify(message)}`
        );
      } else if (['CANCELLED', 'EXPIRED'].includes(agreementStatus)) {
        // Cancelled, Expired) // metering records can still be send for 1 hour after receiving this event. Sending this events for Replaced, Renewed cases will be net new
        logger.info(`agreementId "${agreementId}" ${agreementStatus}: sending message to topic ${TopicArn}`);
        const isoString = new Date().toISOString();
        await publishSNS(
          `AWS Marketplace Agreement "${agreementId}" status "${agreementStatus}" - send metering records`,
          `Agreement ended. You have 1h from ${isoString} to send metering records: ${JSON.stringify(message)}`
        );
      } else {
        logger.info(`status "${agreementStatus}", sendinng generic message`);
        logger.info(`agreementId "${agreementId}" ${agreementStatus}: sending message to topic ${TopicArn}`);
        const isoString = new Date().toISOString();
        await publishSNS(
          `AWS Marketplace Agreement "${agreementId}" status "${agreementStatus}"`,
          `Agreement ended: ${JSON.stringify(message)}`
        );
      }
    // ISV's (MPPO) want to recieve notification when purchase agreements is upgraded
    } else {
      logger.warn(`detail-type "${message['detail-type']}" not handled`);
      //throw new Error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }

    let isFreeTrialTermPresent = false;
    if (typeof message.isFreeTrialTermPresent === "string")  {
     isFreeTrialTermPresent = message.isFreeTrialTermPresent.toLowerCase() === "true";
    }

    // get parameters for DynamodDB
    // we need the acceptor account id and product code
    // acceptor account id
    let acceptorAccountId;
    if (message['detail']['acceptor']['accountId']) {
      acceptorAccountId = message['detail']['acceptor']['accountId'];
      logger.info(`acceptorAccountId: ${acceptorAccountId}`);
    }

    // get offer from message
    let offerId;
    let productId;
    let productCode;
    if (message['detail']['offer']['id']) {
      offerId = message['detail']['offer']['id'];
      logger.info(`offerId: ${offerId}`);
      const mpCatClient = new MarketplaceCatalogClient();

      // call DescribeEntity with offerId to get the productId
      let responseOfferId;
      try {
        responseOfferId = await mpCatClient.send(new DescribeEntityCommand({
          Catalog: 'AWSMarketplace',
          EntityId: offerId
        }));
      } catch (error) {
        logger.error(`Error DescribeEntity for offerId ${offerId}: error: ${error}`);
        return;
      }
      logger.info(`responseOfferId: ${JSON.stringify(responseOfferId, null, 2)}`);
      productId = responseOfferId['DetailsDocument']['ProductId'];
      logger.info(`productId: ${productId}`);

      // call DescribeEntity with productId to get productCode
      let responseProductId;
      try {
        responseProductId = await mpCatClient.send(new DescribeEntityCommand({
          Catalog: 'AWSMarketplace',
          EntityId: productId
        }));
      } catch (error) {
        logger.error(`Error DescribeEntity for productId ${productId}: error: ${error}`);
        return;
      }
      logger.info(`responseProductId: ${JSON.stringify(responseProductId, null, 2)}`);
      productCode = responseProductId['DetailsDocument']['Description']['ProductCode'];
      logger.info(`productCode: ${productCode}`);
      logger.info(`all product information together: offerId: ${offerId} productId: ${productId} productCode: ${productCode}`);
    }

    //let dynamoDbKey = message['customer-identifier']
    let dynamoDbKey = `${acceptorAccountId}-${agreementId}`

    const dynamoDbParams = {
      TableName: newSubscribersTableName,
      Key: {
        customerIdentifier: { S: dynamoDbKey },
      },
      UpdateExpression: 'set subscription_action = :ac, product_id = :pi, successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft, updated_at = :ua',
      ExpressionAttributeValues: {
        ':ac': { S: message['detail-type'] },
        ':pi': { S: productId },
        ':ss': { BOOL: successfullySubscribed },
        ':se': { BOOL: subscriptionExpired },
        ':ft': { BOOL: isFreeTrialTermPresent},
        ':ua': { S: new Date().toISOString() },
      },
      ReturnValues: 'UPDATED_NEW',
    };

    logger.debug(`updating dynamodb with params: ${JSON.stringify(dynamoDbParams, null, 2)}`);
    await dynamodb.updateItem(dynamoDbParams).promise();
    logger.info('dynamodb updated');
  }));
};

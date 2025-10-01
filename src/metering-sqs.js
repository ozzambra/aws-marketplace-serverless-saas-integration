const winston = require('winston');
const AWS = require('aws-sdk');
const { ProductCode: ProductCode, AWSMarketplaceMeteringRecordsTableName: AWSMarketplaceMeteringRecordsTableName , AWS_REGION: aws_region } = process.env;
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
// MarketplaceMetering is instantianize in us-east-1 as all SaaS product listing ARN is stored in us-east-1.
const marketplacemetering = new AWS.MarketplaceMetering({ apiVersion: '2016-01-14', region: 'us-east-1' });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

exports.handler = async (event) => {
  logger.info('event:', JSON.stringify(event, null, 2));
  await Promise.all(event.Records.map(async (record) => {
    const body = JSON.parse(record.body);
    logger.debug(`SQS message body: ${record.body}`);

    const timestmpNow = new Date();

    const UsageRecords = [];
    body.dimension_usage.map((r) => UsageRecords.push(
      {
        CustomerAWSAccountId: body.customerAwsAccountId,
        Dimension: r.dimension,
        Quantity: r.value,
        Timestamp: timestmpNow,
      },
    ));

    const batchMeteringParams = {
      ProductCode,
      UsageRecords,
    };

    let meteringResponse = '';
    let meteringFailed = false;
    try {
      logger.debug(`batchMeteringParams: ${JSON.stringify(batchMeteringParams)}`);
      meteringResponse = await marketplacemetering.batchMeterUsage(batchMeteringParams).promise();
      logger.debug(`meteringResponse: ${JSON.stringify(meteringResponse)}`);
      if(meteringResponse.Results.find(r => r.Status !== 'Success')){
        logger.error(`meteringResponse: ${JSON.stringify(meteringResponse)}`);
        meteringFailed = true;
      }
    } catch (error) {
      meteringResponse = JSON.stringify(error);
      meteringFailed = true;
    }
      

      await Promise.all(body.create_timestamps.map(async (ts) => {
        const dynamoDbParams = {
          TableName: AWSMarketplaceMeteringRecordsTableName,
          Key: {
            customerIdentifier: { S: body.customerAwsAccountId },
            create_timestamp: { N: `${ts}` },
          },
          UpdateExpression: 'set metering_response = :x, metering_failed = :mf remove metering_pending',
          ExpressionAttributeValues: {
            ':x': { S: JSON.stringify(meteringResponse) },
            ':mf': { BOOL: meteringFailed },
          },
          ReturnValues: 'UPDATED_NEW',
        };

        await dynamodb.updateItem(dynamoDbParams).promise();
       
      }));
  
  }));


  return {};
};

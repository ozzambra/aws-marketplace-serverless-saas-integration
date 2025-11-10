const winston = require('winston');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { MarketplaceMeteringClient, BatchMeterUsageCommand } = require('@aws-sdk/client-marketplace-metering');
const { ProductCode: ProductCode, AWSMarketplaceMeteringRecordsTableName: AWSMarketplaceMeteringRecordsTableName , AWS_REGION: aws_region } = process.env;
const dynamodb = new DynamoDBClient({ region: aws_region });
// MarketplaceMetering is instantianize in us-east-1 as all SaaS product listing ARN is stored in us-east-1.
const marketplacemetering = new MarketplaceMeteringClient({ region: 'us-east-1' });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

exports.handler = async (event) => {
  logger.debug({"event" : event});
  await Promise.all(event.Records.map(async (record) => {
    const body = JSON.parse(record.body);
    logger.debug({"SQS message body": body});

    const timestmpNow = new Date();

    const is12Digits = /^\d{12}$/.test(body.customerIdentifier);
    const UsageRecords = [];
    body.dimension_usage.map((r) => UsageRecords.push(
      {
        ...(is12Digits ? { CustomerAWSAccountId: body.customerIdentifier } : { CustomerIdentifier: body.customerIdentifier }),
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
      logger.debug({"batchMeteringParams" : batchMeteringParams});
      meteringResponse = await marketplacemetering.send(new BatchMeterUsageCommand(batchMeteringParams));
      logger.debug({"meteringResponse" :  meteringResponse});
      if(meteringResponse.Results.find(r => r.Status !== 'Success')){
        logger.error({"meteringResponse" :  meteringResponse});
        meteringFailed = true;
      }
    } catch (error) {
      logger.error({'error': error});
      meteringResponse = JSON.stringify(error);
      meteringFailed = true;
    }
      

      await Promise.all(body.create_timestamps.map(async (ts) => {
        const dynamoDbParams = {
          TableName: AWSMarketplaceMeteringRecordsTableName,
          Key: {
            customerIdentifier: { S: body.customerIdentifier },
            create_timestamp: { N: `${ts}` },
          },
          UpdateExpression: 'set metering_response = :x, metering_failed = :mf remove metering_pending',
          ExpressionAttributeValues: {
            ':x': { S: JSON.stringify(meteringResponse) },
            ':mf': { BOOL: meteringFailed },
          },
          ReturnValues: 'UPDATED_NEW',
        };

        await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
       
      }));
  
  }));


  return {};
};

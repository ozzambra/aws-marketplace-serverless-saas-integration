const AWS = require('aws-sdk');
const { NewSubscribersTableName: newSubscribersTableName, EntitlementQueueUrl: entitlementQueueUrl, MarketplaceSellerEmail: marketplaceSellerEmail, AWS_REGION:aws_region } = process.env;
const ses = new AWS.SES({ region: aws_region});
const marketplacemetering = new AWS.MarketplaceMetering({ apiVersion: '2016-01-14', region: aws_region });
const dynamodb = new AWS.DynamoDB({ apiVersion: '2012-08-10', region: aws_region });
const sqs = new AWS.SQS({ apiVersion: '2012-11-05', region: aws_region });

const lambdaResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
  },

  body: JSON.stringify(body),
});

const setBuyerNotificationHandler = function (contactEmail) {
  if (typeof marketplaceSellerEmail == 'undefined') {
    return;
  }
  let params = {
    Destination: {
      ToAddresses: [contactEmail],
    },
    Message: {
      Body: {
        Html: {
          Charset: "UTF-8",
          Data: "<!DOCTYPE html><html><head><title>Welcome!<\/title><\/head><body><h1>Welcome!<\/h1><p>Thanks for purchasing<\/p><p>We\u2019re thrilled to have you on board. Our team is hard at work setting up your account, please expect to hear from a member of our customer success team soon<\/p><\/body><\/html>"
        },
        Text: {
          Charset: "UTF-8",
          Data: "Welcome! Thanks for purchasing. We’re thrilled to have you on board. Our team is hard at work setting up your account, please expect to hear from a member of our customer success team soon"
        }
      },

      Subject: {
        Charset: 'UTF-8',
        Data: "Welcome Email"
      }
    },
    Source: marketplaceSellerEmail,
  };

  // catch SES error. When SES fails to send an email
  // to the email address the customer entered
  // the registering page fails with internal error
  // catching this error solves this internal error message
  ses.sendEmail(params).promise()
    .then(result => {
      return true
    })
    .catch(error => {
        console.error('sending email via SES failed:', error);
        return false
    });
};

exports.registerNewSubscriber = async (event) => {
  console.log('event:', JSON.stringify(event, null, 2));
  const {
    // Accept form inputs from ../web/index.html
    regToken, companyName, contactPerson, contactPhone, contactEmail,
  } = JSON.parse(event.body);

  // Validate the request with form inputs from ../web/index.html
  if (regToken && companyName && contactPerson && contactPhone && contactEmail) {
    try {
      // Call resolveCustomer to validate the subscriber
      const resolveCustomerParams = {
        RegistrationToken: regToken,
      };

      const resolveCustomerResponse = await marketplacemetering
        .resolveCustomer(resolveCustomerParams)
        .promise();

      // Store new subscriber data in dynamoDb
      // Once the ResolveCustomer API return the AgreementID we will use this as customerIdentifier
      const { CustomerIdentifier, ProductCode, CustomerAWSAccountId } = resolveCustomerResponse;
      console.log(`CustomerIdentifier: ${CustomerIdentifier} ProductCode: ${ProductCode} CustomerAWSAccountId: ${CustomerAWSAccountId}`);

      const datetime = new Date().getTime().toString();

      // Write form inputs from ../web/index.html
      // Add customerAwsAccountId
      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Item: {
          companyName: { S: companyName },
          contactPerson: { S: contactPerson },
          contactPhone: { S: contactPhone },
          contactEmail: { S: contactEmail },
          productCode: { S: ProductCode },
          customerAwsAccountId: { S: CustomerAWSAccountId },
          customerIdentifier: { S: CustomerIdentifier },         
          created: { S: datetime },
        },
      };

      console.log(`updating DynamoDB with dynamoDbParams: ${JSON.stringify(dynamoDbParams, null, 2)}`);
      await dynamodb.putItem(dynamoDbParams).promise();
      console.log('DynamoDB updated');

      // Only for SaaS Contracts, check entitlement
      if (entitlementQueueUrl) {
        const SQSParams = {
          MessageBody: `{ 
              "Type": "Notification", 
              "Message" : {
                  "action" : "entitlement-updated",
                  "customer-aws-account-id": "${CustomerAWSAccountId}",
                  "customer-identifier" : "${CustomerIdentifier}",
                  "product-code" : "${ProductCode}",
                  "origin" : "lambda:${process.env.AWS_LAMBDA_FUNCTION_NAME}"
                  } 
              }`,
          QueueUrl: entitlementQueueUrl,
        };

        console.log(`sending message to SQS "${entitlementQueueUrl}" with params: ${JSON.stringify(SQSParams, null, 2)}`);
        await sqs.sendMessage(SQSParams).promise();
        console.log('message sent to SQS');
      }

      await setBuyerNotificationHandler(contactEmail);

      return lambdaResponse(200, 'Success! Registration completed. You have purchased an enterprise product that requires some additional setup. A representative from our team will be contacting you within two business days with your account credentials. Please contact Support through our website if you have any questions.');
    } catch (error) {
      console.error(error);
      return lambdaResponse(400, 'Registration data not valid. Please try again, or contact support!');
    }
  } else {
    return lambdaResponse(400, 'Request no valid');
  }
};

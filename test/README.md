# Testing AWS Marketplace Serverless SaaS Integration

This readme contains test scenarios to verify that the 
**AWS Marketplace Serverless SaaS Integration** is working as expected.

## Prerequisites

* You must have created a SaaS product with the desired product type listing (contracts_with_subscription, contracts, subscriptions).
* SaaS Integration deployed
* Fulfillment URL updated for you product (can be automatically done during deployment).
* Confirm your SNS subscription for the tech contact you provided during deployment.

## Testing

### Subscribing

* Subscribe to a product
* Choose **Set up your account** and fill out the registration page
* Wait until page reqistration and product subscription have been finished
* Scan your **NewSubscribersTableName** DynamoDB table:
  * `aws dynamodb scan --table-name REPLACE_WITH_YOUR_TABLE`
* The output must include both keys **successfully_registered** and **successfully_subscribed** set to **true**. The key **successfully_registered** indicates that the reqistration page (Fulfillment URL) was processed correctly and the key **successfully_subscribed** indicates if the subscriptions on the marketplace has been successful.
* You tech contact should receive an email with the subject **New AWS Marketplace Subscriber**.
* Query all logs for errors

#### Querying logs
You can either go manually through CloudWatch logs and look for errors, you can use CloudWatch Insights or the script [query-cw-logs.sh](query-cw-logs.sh).

All log files inlucde your CloudFormation stack name. If your stack name is **mp-saas-integration** and you want to find all messages containing error, execute:

```bash
./query-cw-logs.sh "mp-saas-integration" "error"
```

### Unsubscribing

* Cancel a subscription or wait until a contract product expired.
* DynamoDB keys **successfully_registered** and **subscription_expired** must be false.
* Your tech contact should get an email with the subject **AWS Marketplace customer end of subscription**.


### Metering

t.b.d.


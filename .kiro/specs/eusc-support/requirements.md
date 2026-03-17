# Requirements Document

## Introduction

This document defines the requirements for adding AWS European Sovereign Cloud (EUSC) support to the existing AWS Marketplace Serverless SaaS Integration project. EUSC is a separate AWS partition (`aws-eusc`) with distinct regional endpoints, ARN formats, and behavioral differences from standard AWS commercial regions. The most significant behavioral differences are: (1) EUSC does not support concurrent agreements, (2) EUSC does not have an endpoint for the Marketplace Catalog API, and (3) EUSC does not have an endpoint for the Marketplace Agreement API. The absence of the Catalog API means that all Catalog API calls must be eliminated when deploying to EUSC, and custom resource Lambda functions that depend on the Catalog API (GetProductCode, FulfillmentURL) must not be deployed. The absence of the Agreement API means that all Agreement API calls (e.g., DescribeAgreement) must be skipped when deployed to EUSC. The current implementation has multiple hardcoded references to `us-east-1` and the `aws` partition that must be made configurable to support EUSC deployment.

## Glossary

- **EUSC**: AWS European Sovereign Cloud — a separate AWS partition designed for European data sovereignty requirements, using the `aws-eusc` partition.
- **SAM_Template**: The AWS SAM `template.yaml` file that defines all infrastructure resources (Lambda functions, DynamoDB tables, SQS queues, EventBridge rules, etc.) for the SaaS integration.
- **Entitlement_Handler**: The Lambda function (`entitlement-sqs.js`) that processes license update and deprovisioning events from EventBridge via SQS and updates subscriber entitlements in DynamoDB.
- **Subscription_Handler**: The Lambda function (`subscription-sqs.js`) that processes purchase agreement events from EventBridge via SQS and updates subscriber status in DynamoDB.
- **Metering_Handler**: The Lambda function (`metering-sqs.js`) that sends batched metering records to the AWS Marketplace Metering Service.
- **Metering_Job**: The Lambda function (`metering-hourly-job.js`) that queries pending metering records from DynamoDB and sends them to the metering SQS queue on an hourly schedule.
- **Registration_Handler**: The Lambda function (`register-new-subscriber.js`) that resolves marketplace tokens and registers new subscribers in DynamoDB.
- **Partition**: The SAM template parameter (and corresponding environment variable) that identifies the AWS partition for the deployment. Used to determine the correct regional endpoints for AWS Marketplace API calls and ARN construction. Values include `aws` for commercial and `aws-eusc` for EUSC.
- **Concurrent_Agreement**: The ability for a buyer to hold multiple active agreements for the same product simultaneously. EUSC does not support this capability.
- **Agreement_Client**: The AWS SDK client (`MarketplaceAgreementClient`) used to call the DescribeAgreement API. The Agreement API is not available in the EUSC partition.
- **Agreement_API**: The AWS Marketplace Agreement API, used for operations such as DescribeAgreement. This API does not have an endpoint in the EUSC (`aws-eusc`) partition.
- **Metering_Client**: The AWS SDK client (`MarketplaceMeteringClient`) used to call the BatchMeterUsage API.
- **Catalog_Client**: The AWS SDK client (`MarketplaceCatalogClient`) used to call the DescribeEntity API. The Catalog API is not available in the EUSC partition.
- **Catalog_API**: The AWS Marketplace Catalog API, used for operations such as DescribeEntity and StartChangeSet. This API does not have an endpoint in the EUSC (`aws-eusc`) partition.
- **IsCommercialPartition**: A CloudFormation Condition in the SAM_Template that evaluates to `true` when the `Partition` parameter is set to `aws` (commercial), and `false` otherwise. Used to conditionally create resources that depend on the Catalog_API.

## Requirements

### Requirement 1: Configurable Partition for Lambda Functions

**User Story:** As a SaaS seller deploying to EUSC, I want the partition used by Lambda functions to be configurable, so that SDK clients connect to the correct regional endpoints instead of hardcoded `us-east-1`.

#### Acceptance Criteria

1. THE SAM_Template SHALL expose a parameter named `Partition` that specifies the AWS partition for Marketplace API calls, with a default value of `aws`.
2. THE SAM_Template SHALL pass the `Partition` parameter as an environment variable to the Entitlement_Handler, Subscription_Handler, Metering_Handler, and Registration_Handler Lambda functions.
3. WHILE the `Partition` environment variable is set to `aws`, THE Entitlement_Handler SHALL initialize the Agreement_Client using the `Partition` environment variable to determine the region and call the DescribeAgreement API.
4. WHILE the `Partition` environment variable is set to `aws-eusc`, THE Entitlement_Handler SHALL skip all Agreement_API calls.
5. WHILE the `Partition` environment variable is set to `aws`, THE Subscription_Handler SHALL initialize the Agreement_Client using the `Partition` environment variable to determine the region and call the DescribeAgreement API.
6. WHILE the `Partition` environment variable is set to `aws-eusc`, THE Subscription_Handler SHALL skip all Agreement_API calls.
7. WHEN the Metering_Handler initializes the Metering_Client, THE Metering_Handler SHALL use the `Partition` environment variable to determine the region instead of the hardcoded value `us-east-1`.
8. REGARDLESS of the `Partition` environment variable value, THE Entitlement_Handler SHALL always call GetEntitlements to retrieve the subscriber's entitlement dimensions.
9. WHILE the `Partition` environment variable is set to `aws-eusc`, THE Entitlement_Handler SHALL skip all Catalog_API calls. WHILE the `Partition` environment variable is set to `aws`, THE Entitlement_Handler MAY use the Catalog_API to enrich entitlement data.
10. WHEN the product code is available in the event payload, THE Subscription_Handler SHALL use the product code from the event payload directly and skip the Catalog_API call.
11. WHEN the product code is NOT available in the event payload AND the `Partition` environment variable is set to `aws`, THE Subscription_Handler SHALL initialize the Catalog_Client and call the DescribeEntity API to resolve the product code. WHEN the product code is NOT available in the event payload AND the `Partition` is set to `aws-eusc`, THE Subscription_Handler SHALL log a warning since the Catalog_API is unavailable.

### Requirement 2: Partition-Aware ARN Construction

**User Story:** As a SaaS seller deploying to EUSC, I want ARN references to use the correct partition, so that IAM policies and resource identifiers are valid in the EUSC partition.

#### Acceptance Criteria

1. THE SAM_Template SHALL use `${AWS::Partition}` in all ARN constructions within IAM policies and resource references instead of hardcoded `aws` partition values.
2. WHEN the Metering_Handler checks whether a customer identifier is a License ARN, THE Metering_Handler SHALL match against a partition-aware ARN prefix pattern (not only `arn:aws:license-manager:`) to support both commercial and EUSC partitions.
3. WHILE the IsCommercialPartition condition is true, THE SAM_Template SHALL use `${AWS::Partition}` in the custom resource Lambda functions (GetProductCode, FulfillmentURL) for Marketplace Catalog ARN resources.

### Requirement 3: Conditional Deployment of Catalog API Custom Resources

**User Story:** As a SaaS seller deploying to EUSC, I want the custom resource Lambda functions that depend on the Marketplace Catalog API to be excluded from the deployment, so that the stack deploys successfully without attempting to call an unavailable API.

#### Acceptance Criteria

1. THE SAM_Template SHALL define a CloudFormation Condition named `IsCommercialPartition` that evaluates to `true` when the `Partition` parameter equals `aws`.
2. THE SAM_Template SHALL attach the `IsCommercialPartition` condition to the GetProductCode custom resource Lambda function and all its associated resources (IAM role, invocation), so that the GetProductCode Lambda is only created in commercial partitions.
3. THE SAM_Template SHALL attach the `IsCommercialPartition` condition to the FulfillmentURL custom resource Lambda function and all its associated resources (IAM role, invocation), so that the FulfillmentURL Lambda is only created in commercial partitions.
4. WHEN the `Partition` parameter is set to `aws-eusc`, THE SAM_Template SHALL deploy successfully without creating any resources that depend on the Catalog_API.
5. WHEN the `Partition` parameter is set to `aws`, THE SAM_Template SHALL create the GetProductCode and FulfillmentURL custom resource Lambda functions as before.

### Requirement 4: No Concurrent Agreement Support in EUSC

**User Story:** As a SaaS seller deploying to EUSC, I want the integration to handle the absence of concurrent agreements, so that subscription and entitlement processing works correctly when only one active agreement per buyer per product is allowed.

#### Acceptance Criteria

1. THE SAM_Template SHALL expose a parameter named `SupportsConcurrentAgreements` with allowed values `true` and `false`, defaulting to `true`.
2. THE SAM_Template SHALL pass the `SupportsConcurrentAgreements` parameter as an environment variable to the Entitlement_Handler and Subscription_Handler.
3. WHILE `SupportsConcurrentAgreements` is set to `false`, THE Entitlement_Handler SHALL use the acceptor account ID as the DynamoDB key for subscriber records instead of the license ARN.
4. WHILE `SupportsConcurrentAgreements` is set to `false`, THE Subscription_Handler SHALL process agreement ended events using the acceptor account ID as the sole DynamoDB key.
5. WHILE `SupportsConcurrentAgreements` is set to `true`, THE Entitlement_Handler SHALL continue to use the license ARN as the DynamoDB key for subscriber records.

### Requirement 5: Configurable EventBridge Event Source for EUSC

**User Story:** As a SaaS seller deploying to EUSC, I want the EventBridge event source to be configurable, so that the integration can receive marketplace events from the correct EUSC event source.

#### Acceptance Criteria

1. THE SAM_Template SHALL allow the `MarketplaceEventSource` parameter to accept EUSC-specific event source values in addition to the existing commercial and test values.
2. THE SAM_Template SHALL use the `MarketplaceEventSource` parameter value in both the `MarketplaceSellerLicense` and `MarketplaceSellerPurchase` EventBridge rule event patterns.

### Requirement 6: EUSC-Compatible Registration Flow

**User Story:** As a SaaS seller deploying to EUSC, I want the subscriber registration flow to use the correct regional endpoints, so that token resolution and subscriber creation work in the EUSC partition.

#### Acceptance Criteria

1. THE SAM_Template SHALL pass the `Partition` parameter as an environment variable to the Registration_Handler.
2. WHEN the Registration_Handler initializes the Metering_Client for ResolveCustomer calls, THE Registration_Handler SHALL use the `Partition` environment variable to determine the region.
3. WHILE `SupportsConcurrentAgreements` is set to `false`, THE Registration_Handler SHALL use the customer AWS account ID as the DynamoDB key for subscriber records instead of the license ARN.

### Requirement 7: EUSC Deployment Documentation

**User Story:** As a SaaS seller, I want clear documentation on how to deploy the integration to EUSC, so that I can configure all required parameters correctly.

#### Acceptance Criteria

1. THE README SHALL include a section describing the EUSC deployment configuration, listing all EUSC-specific parameter values.
2. THE README SHALL document that `SupportsConcurrentAgreements` must be set to `false` for EUSC deployments.
3. THE README SHALL document the correct `Partition` value to use for EUSC deployments.
4. THE README SHALL document the correct `MarketplaceEventSource` value to use for EUSC deployments.
5. THE README SHALL document that the Marketplace Catalog API is not available in the EUSC partition, and that the GetProductCode and FulfillmentURL custom resource Lambda functions are automatically excluded from EUSC deployments via the `IsCommercialPartition` CloudFormation Condition.
6. THE README SHALL document that the Entitlement_Handler and Subscription_Handler skip Catalog_API and Agreement_API calls when deployed to EUSC, and explain any behavioral differences this causes.

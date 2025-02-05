// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type GitRepoParams = {
  gitHost: string;
  gitProjectGroup: string;
  gitRepoName: string;  
}

export type AppPromoParams = GitRepoParams & {
  gitJobID: string;
  envName: string;
  envRequiresManualApproval: boolean;
  appName: string;
  providers: AWSProviderParams[];
};

export type AWSProviderParams = {
  awsAccount: string;
  awsRegion: string;
  assumedRoleArn: string;
  environmentName: string;
  envRequiresManualApproval: boolean;
  prefix: string;
  providerName: string;
  parameters: { [key: string]: string }     //Parameters key value map for provision the app on the designated provider
}

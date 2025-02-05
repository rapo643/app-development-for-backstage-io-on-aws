// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CatalogApi } from '@backstage/catalog-client';
import { JsonArray, } from '@backstage/types';
import { Entity, EntityRelation, RELATION_DEPENDS_ON } from '@backstage/catalog-model';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import yaml from 'yaml';
import { getAWScreds } from '@aws/plugin-aws-apps-backend-for-backstage';
import { getSSMParameterValue } from '../../helpers/action-context';
import { EnvironmentProvider } from '../../types';

const ID = 'opa:get-env-providers';

const examples = [
  {
    description: 'Retreive AWS environment providers so that their configurations can be used by other template actions',
    example: yaml.stringify({
      steps: [
        {
          action: ID,
          id: 'opaGetAwsEnvProviders',
          name: 'Get AWS Environment Providers',
          input: {
            environmentRef: 'awsenvironment:Test-Environment',
          },
        },
      ],
    }),
  },
];

interface DeploymentParameters {
  envName: string;
  envRef: string;
  envProviderName: string;
  envProviderType: string;
  envProviderPrefix: string;
  accountId: string;
  region: string;
  ssmAssumeRoleArn: string;
  ssmPathVpc: string;
  ssmPublicSubnets: string;
  ssmPrivateSubnets: string;
  ssmPathCluster: string;
}

export function getEnvProvidersAction(options: { catalogClient: CatalogApi }) {
  const { catalogClient } = options;

  return createTemplateAction<{
    environmentRef: string;
  }>({
    id: ID,
    description: 'Retrieves AWS Environment Provider data',
    examples,
    schema: {
      input: {
        required: ['environmentRef'],
        type: 'object',
        properties: {
          environmentRef: {
            type: 'string',
            title: 'Entity reference',
            description: 'The entity reference identifier for an AWS Environment',
          },
        },
      },
      output: {
        type: 'object',
        required: [
          'envName',
          'envShortName',
          'envRef',
          'envDeployManualApproval',
          'envProviders',
        ],
        properties: {
          envName: {
            title: 'The AWS environment name',
            type: 'string',
          },
          envShortName: {
            title: 'The short AWS environment name e.g. dev, qa, prod',
            type: 'string',
          },
          envRef: {
            title: 'The entity reference ID of the environment',
            type: 'string',
          },
          envDeployManualApproval: {
            title: 'Whether manual approval is required for deploying to the environment',
            type: 'boolean',
          },
          envProviders: {
            title: 'The AWS environment providers',
            type: 'array',
            items: {
              type: 'object',
              required: [
                'envProviderName',
                'envProviderType',
                'envProviderPrefix',
                'account',
                'region',
                'vpcId',
                'publicSubnets',
                'privateSubnets',
                'assumedRoleArn'
              ],
              properties: {
                envProviderName: {
                  title: 'The AWS environment provider name',
                  type: 'string',
                },
                envProviderType: {
                  title: 'The AWS environment provider type',
                  type: 'string',
                },
                account: {
                  title: 'The AWS account where infrastructure will be deployed',
                  type: 'string',
                },
                region: {
                  title: 'The AWS region where infrastructure will be deployed',
                  type: 'string',
                },
                vpcId: {
                  title: 'The VPC identifier where infrastructure will be deployed',
                  type: 'string',
                },
                publicSubnets: {
                  title: 'The VPC public subnet ids',
                  type: 'array',
                },
                privateSubnets: {
                  title: 'The VPC private subnet ids',
                  type: 'array',
                },
                clusterArn: {
                  title: 'The Arn of the cluster where the service and task are deployed, if needed. A cluster could be ECS or EKS',
                  type: 'string',
                },
                assumedRoleArn: {
                  title: 'The Arn of AWS IAM role that can be assumed to deploy resources to the environment provider',
                  type: 'string',
                },
              }
            }
          },
        }
      },
    },
    async handler(ctx) {
      const { environmentRef } = ctx.input;
      const token = ctx.secrets?.backstageToken;

      ctx.logger.info(`environmentRef: ${environmentRef}`);

      // Fail early if there is no user entity
      if (ctx.user?.entity === undefined) {
        ctx.logger.info(`No user context provided for ${ID} action`);
        return;
      }

      const awsEnvEntity = await catalogClient.getEntityByRef(environmentRef, { token });
      if (awsEnvEntity === undefined) {
        throw new Error(`The environment entity "${environmentRef}" could not be located in the catalog.`);
      }

      const envShortName = awsEnvEntity.metadata['short-name']?.toString() || '';
      ctx.output('envName', awsEnvEntity.metadata.name);
      ctx.output('envRef', environmentRef);
      ctx.output('envDeployManualApproval', "true" === awsEnvEntity.metadata['deployment_requires_approval']?.toString() || '')
      ctx.output('envShortName', envShortName);

      const deploymentParametersArray = await getEnvDeploymentParameters(awsEnvEntity);

      ctx.logger.debug(`envProviders info: ${JSON.stringify(deploymentParametersArray, null, 2)}`);

      const envProviderOutputArray: JsonArray = [];

      // looping over all providers of the selected environment
      for (const params of deploymentParametersArray) {
        const { accountId, region, ssmAssumeRoleArn, ssmPathVpc, ssmPublicSubnets, ssmPrivateSubnets, ssmPathCluster,
          envProviderName, envProviderType, envProviderPrefix } = params;

        if (!accountId) {
          throw new Error(`accountId not configured for environment provider: ${envProviderName}. The provider IaC deployment may have failed.`);
        }
        if (!region) {
          throw new Error(`region not configured for environment provider: ${envProviderName}. The provider IaC deployment may have failed.`);
        }
        if (!ssmAssumeRoleArn) {
          throw new Error(`ssmAssumeRoleArn not configured for environment provider: ${envProviderName}. The provider IaC deployment may have failed.`);
        }
        if (!ssmPathVpc) {
          throw new Error(`ssmPathVpc not configured for environment provider: ${envProviderName}. The provider IaC deployment may have failed.`);
        }

        // Get AWS credentials for the specific provider
        ctx.logger.info(`Getting credentials for AWS deployment to account ${accountId} in ${region}`);
        const response = await getAWScreds(accountId, region, envProviderPrefix, envProviderName, ctx.user!.entity!);
        const { credentials } = response;

        try {
          const vpcId = await getSSMParameterValue(region, credentials, ssmPathVpc, ctx.logger);
          const publicSubnets = await getSSMParameterValue(region, credentials, ssmPublicSubnets, ctx.logger);
          const privateSubnets = await getSSMParameterValue(region, credentials, ssmPrivateSubnets, ctx.logger);
          const clusterArn = (envProviderType === 'ecs' || envProviderType === 'eks') ? await getSSMParameterValue(region, credentials, ssmPathCluster, ctx.logger) : '';
          const assumedRoleArn = await getSSMParameterValue(region, credentials, ssmAssumeRoleArn, ctx.logger);

          const envProvider: EnvironmentProvider = {
            envProviderName,
            envProviderType,
            envProviderPrefix,
            accountId,
            region,
            vpcId,
            publicSubnets,
            privateSubnets,
            clusterArn,
            assumedRoleArn,
          };

          envProviderOutputArray.push(envProvider);
        } catch (err: any) {
          throw new Error(`Failed to populate environment provider ${envProviderName}. ${err.toString()}`)
        }
      }

      ctx.logger.info(`Resolved environment providers: ${JSON.stringify(envProviderOutputArray, null, 2)}`);

      ctx.output('envProviders', envProviderOutputArray);

      // For a given AWS Environment entity, get the defined attributes required for a deployment to AWS
      async function getEnvDeploymentParameters(envEntity: Entity): Promise<DeploymentParameters[]> {
        const entityRelations: EntityRelation[] = envEntity?.relations ?? [];
        const envProvRefs: string[] = entityRelations
          .filter(
            envProvRel =>
              envProvRel.type === RELATION_DEPENDS_ON && envProvRel.targetRef.startsWith('awsenvironmentprovider'),
          )
          .map(envProvRel => envProvRel.targetRef);

        const envProviderEntities = await catalogClient.getEntitiesByRefs({ entityRefs: envProvRefs }, { token });

        const deploymentParams: DeploymentParameters[] = envProviderEntities.items
          .filter(
            entity =>
              entity &&
              ['name', 'env-type', 'aws-account', 'aws-region', 'vpc'].every(key => key in entity.metadata),
          )
          .map(entity => {
            const { metadata } = entity!;
            const vpc = metadata.vpc?.toString() || '';

            const deployParams: DeploymentParameters = {
              envProviderPrefix: metadata['prefix']?.toString() || '',
              envName: envEntity.metadata.name,
              envProviderName: metadata.name,
              envRef: environmentRef,
              envProviderType: metadata['env-type']?.toString().toLowerCase() || '',
              accountId: metadata['aws-account']?.toString() || '',
              region: metadata['aws-region']?.toString() || '',
              ssmAssumeRoleArn: metadata['provisioning-role']?.toString() || '',
              ssmPathVpc: vpc,
              ssmPrivateSubnets: `${vpc}/private-subnets`,
              ssmPublicSubnets: `${vpc}/public-subnets`,
              ssmPathCluster: metadata['cluster-name']?.toString() || '',
            };
            return deployParams;
          });

        return deploymentParams;
      }
    },
  });

}

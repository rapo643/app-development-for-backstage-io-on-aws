// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import { OPAEnvironmentParams, NetworkConstruct } from "@aws/aws-app-development-common-constructs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import { BlockDeviceVolume } from "aws-cdk-lib/aws-autoscaling";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { readFileSync } from "fs";
import { NagSuppressions } from "cdk-nag";

export interface EipLookupInfo {
  readonly attrPublicIp: string;
  readonly attrAllocationId: string;
}

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface GitlabRunnerConstructProps extends cdk.StackProps {
  readonly opaEnv: OPAEnvironmentParams;
  readonly network: NetworkConstruct;
  readonly runnerSg: cdk.aws_ec2.ISecurityGroup;
  readonly GitlabAmi: Record<string, string>;
  readonly gitlabSecret: secretsmanager.Secret;
  readonly instanceDiskSize: number;
  readonly instanceSize: ec2.InstanceSize;
  readonly instanceClass: ec2.InstanceClass;
}

const defaultProps: Partial<GitlabRunnerConstructProps> = {};

/**
 * Deploys the GitlabRunnerConstruct construct
 */
export class GitlabRunnerConstruct extends Construct {
  constructor(parent: Construct, name: string, props: GitlabRunnerConstructProps) {
    super(parent, name);

    /* eslint-disable @typescript-eslint/no-unused-vars */
    props = { ...defaultProps, ...props };

    const glRunnerEc2SgName = `${props.opaEnv.prefix}-gitlab-runner-sg`;
    const instanceSecurityGroup = new ec2.SecurityGroup(this, glRunnerEc2SgName, { vpc: props.network.vpc });

    instanceSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.network.vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "allow traffic from vpc"
    );

    cdk.Tags.of(instanceSecurityGroup).add("Name", glRunnerEc2SgName);

    const gitlabIamRolePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ["*"],
          actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        }),

        new iam.PolicyStatement({
          resources: [props.gitlabSecret.secretArn],
          actions: [
            "secretsmanager:DescribeSecret",
            "secretsmanager:GetSecretValue",
            "secretsmanager:GetSecretValue",
            "secretsmanager:PutSecretValue",
          ],
        }),

        // Allow GitLab Runner to build and publish app images to ECR
        new iam.PolicyStatement({
          resources: ["*"],
          actions: [
            "ecr:GetAuthorizationToken",
            "ecr:CompleteLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:InitiateLayerUpload",
            "ecr:BatchCheckLayerAvailability",
            "ecr:PutImage",
          ],
        }),


        // Allow GitLab Runner to put build artifacts in S3
        new iam.PolicyStatement({
          actions: ["s3:PutObject"],
          effect: iam.Effect.ALLOW,
          resources: ["*"],
          conditions: {
            StringEquals: {
              "aws:ResourceAccount": props.opaEnv.awsAccount,
            },
          },
        }),

        // Allow GitLab Runner to describe CloudFormation stacks
        new iam.PolicyStatement({
          actions: [
            "cloudformation:DescribeStacks",
            "cloudformation:ListStackResources"
          ],
          effect: iam.Effect.ALLOW,
          resources: ["*"],
          conditions: {
            StringEquals: {
              "aws:ResourceAccount": props.opaEnv.awsAccount,
            },
          },
        }),

        // Allow Gitlab Runner to assume Environment provisioning roles
        // ATTENTION: in a production scenario, the gitlab runner policy below
        // should be updated to restrict the Resources to only the iam roles
        // that follow a naming convention in target accounts where infrastructure
        // will be provisioned.  For example: 
        //    "arn:aws:iam::123456789012:role/opa-environment-provisioning-role"
        new iam.PolicyStatement({
          actions: [
            "sts:AssumeRole",
          ],
          effect: iam.Effect.ALLOW,
          resources: ["*"],
        }),

      ],
    });

    const gitlabEc2Role = new iam.Role(this, "GitlabRunnerIamRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Iam Role assumed by the Gitlab Runner",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentAdminPolicy"),
      ],
      inlinePolicies: { GitlabIamRolePolicy: gitlabIamRolePolicy },
    });

    NagSuppressions.addResourceSuppressions(gitlabEc2Role, [
      { id: "AwsSolutions-IAM4", reason: "Assumed roles will use AWS managed policies for demonstration purposes.  Customers will be advised/required to assess and apply custom policies based on their role requirements" },
      { id: "AwsSolutions-IAM5", reason: "Assumed roles will require permissions to perform multiple ecs, ddb, and ec2 for demonstration purposes.  Customers will be advised/required to assess and apply minimal permission based on role mappings to their idP groups" },
    ], true);

    const blockDevice: autoscaling.BlockDevice = {
      deviceName: "/dev/sda1",
      volume: BlockDeviceVolume.ebs(props.instanceDiskSize, {
        encrypted: true,
        volumeType: autoscaling.EbsDeviceVolumeType.GP3,
      }),
    };

    const userData = ec2.UserData.forLinux();
    const userDataScript = readFileSync("./src/scripts/gitlab-runner-user-data.sh", "utf8");
    userData.addCommands(userDataScript);

    const launchTemplate = new ec2.LaunchTemplate(this, "GitLabRunnerLaunchTemplate", {
      instanceType: ec2.InstanceType.of(props.instanceClass, props.instanceSize),
      userData,
      securityGroup: instanceSecurityGroup,
      requireImdsv2: true,
      role: gitlabEc2Role,
      machineImage: ec2.MachineImage.genericLinux(props.GitlabAmi),
      httpPutResponseHopLimit: 2,
      blockDevices: [blockDevice],
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });
    launchTemplate.connections.addSecurityGroup(props.runnerSg);

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, "GitLabRunnerAutoScalingGroup", {
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      allowAllOutbound: true,
      healthCheck: autoscaling.HealthCheck.ec2(),
      minCapacity: 1,
      maxCapacity: 1,
      launchTemplate,
    });

    NagSuppressions.addResourceSuppressions(autoScalingGroup, [
      { id: 'AwsSolutions-AS3', reason: 'Gitlab runner EC2 instance simulates a 3rd party implementation which is not part of the prototype and does not need to be monitored for scaling events.' },
    ]);

    // save root role in a param
    const roleParam = new ssm.StringParameter(this, `${props.opaEnv.prefix}-pipeline-role`, {
      allowedPattern: ".*",
      description: `The OPA Platform Pipeline Role Arn`,
      parameterName: `/${props.opaEnv.prefix}/pipeline-role`,
      stringValue: gitlabEc2Role.roleArn,
    });

    new cdk.CfnOutput(this, `The OPA Platform Pipeline Role Arn Parameter`, {
      value: roleParam.parameterName,
    });
  }
}

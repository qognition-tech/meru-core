#!/bin/bash

# Meru Enterprise - Complete Setup Script
# Sets up 3 EC2 instances with Docker + Databases + Monitoring

set -e

echo "🚀 Starting Meru Enterprise Setup..."
echo "This will set up:"
echo "  - 3 EC2 instances (Meru, Immigration, GRC)"
echo "  - 3 RDS databases (1 per vertical)"
echo "  - 3 S3 buckets (1 per vertical)"
echo "  - Route 53 DNS records"
echo "  - ACM SSL certificates"
echo "  - Grafana + Prometheus monitoring"
echo ""

# AWS Configuration
AWS_REGION="${AWS_REGION:-ap-south-1}"
VPC_ID="${VPC_ID:-}"
SUBNET_IDS="${SUBNET_IDS:-}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:-}"
KEY_NAME="meru-enterprise-key"

# EC2 Configuration
EC2_INSTANCE_TYPE="${EC2_INSTANCE_TYPE:-t3.medium}"
EC2_AMI="${EC2_AMI:-ami-0abcdef1234567890}"

# Database Configuration
RDS_INSTANCE_CLASS="${RDS_INSTANCE_CLASS:-db.t3.micro}"
RDS_ALLOCATED_STORAGE="${RDS_ALLOCATED_STORAGE:-20}"
DB_USERNAME="meruadmin"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 32)}"

# Domain Configuration
DOMAIN_BASE="${DOMAIN_BASE:-meru.com}"
IMMIGRATION_DOMAIN="${IMMIGRATION_DOMAIN:-immistack.com}"
GRC_DOMAIN="${GRC_DOMAIN:-governancex.com}"

echo "==========================================="
echo "Step 1: Create Key Pair"
echo "==========================================="

# Create SSH key pair
aws ec2 create-key-pair \
  --key-name $KEY_NAME \
  --query 'KeyMaterial' \
  --output text > ${KEY_NAME}.pem

chmod 400 ${KEY_NAME}.pem
echo "✅ SSH key pair created: ${KEY_NAME}.pem"

echo ""
echo "==========================================="
echo "Step 2: Create Security Groups"
echo "==========================================="

# Create security groups
MERU_SG=$(aws ec2 create-security-group \
  --group-name meru-core-sg \
  --description "Meru Core Security Group" \
  --vpc-id $VPC_ID \
  --output text)

IMMIGRATION_SG=$(aws ec2 create-security-group \
  --group-name immigration-sg \
  --description "Immigration Security Group" \
  --vpc-id $VPC_ID \
  --output text)

GRC_SG=$(aws ec2 create-security-group \
  --group-name grc-sg \
  --description "GRC Security Group" \
  --vpc-id $VPC_ID \
  --output text)

echo "✅ Security groups created"

# Authorize security groups (allow HTTP, HTTPS, SSH)
for SG_ID in $MERU_SG $IMMIGRATION_SG $GRC_SG; do
  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 80 \
    --cidr 0.0.0.0/0

  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 443 \
    --cidr 0.0.0.0/0

  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 3000-3002 \
    --source-group $SG_ID

  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 9090 \
    --source-group $SG_ID

  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 3000 \
    --source-group $SG_ID
done

echo "✅ Security group rules configured"

echo ""
echo "==========================================="
echo "Step 3: Create RDS Databases"
echo "==========================================="

# Create RDS subnet group (if not exists)
aws rds create-db-subnet-group \
  --db-subnet-group-name meru-db-subnet-group \
  --db-subnet-group-description "Meru Database Subnet Group" \
  --subnet-ids $SUBNET_IDS || true

# Create Meru Core Database
MERU_RDS_ENDPOINT=$(aws rds create-db-instance \
  --db-instance-identifier meru-core-prod \
  --db-instance-class $RDS_INSTANCE_CLASS \
  --engine postgres \
  --engine-version 15.4 \
  --allocated-storage $RDS_ALLOCATED_STORAGE \
  --master-username $DB_USERNAME \
  --master-user-password $DB_PASSWORD \
  --vpc-security-group-ids $MERU_SG \
  --db-subnet-group-name meru-db-subnet-group \
  --backup-retention-period 30 \
  --multi-az false \
  --publicly-accessible false \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

echo "✅ Meru Core RDS created: $MERU_RDS_ENDPOINT"

# Create Immigration Database
IMM_RDS_ENDPOINT=$(aws rds create-db-instance \
  --db-instance-identifier immigration-prod \
  --db-instance-class $RDS_INSTANCE_CLASS \
  --engine postgres \
  --engine-version 15.4 \
  --allocated-storage $RDS_ALLOCATED_STORAGE \
  --master-username $DB_USERNAME \
  --master-user-password $DB_PASSWORD \
  --vpc-security-group-ids $IMMIGRATION_SG \
  --db-subnet-group-name meru-db-subnet-group \
  --backup-retention-period 30 \
  --multi-az false \
  --publicly-accessible false \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

echo "✅ Immigration RDS created: $IMM_RDS_ENDPOINT"

# Create GRC Database
GRC_RDS_ENDPOINT=$(aws rds create-db-instance \
  --db-instance-identifier grc-prod \
  --db-instance-class $RDS_INSTANCE_CLASS \
  --engine postgres \
  --engine-version 15.4 \
  --allocated-storage $RDS_ALLOCATED_STORAGE \
  --master-username $DB_USERNAME \
  --master-user-password $DB_PASSWORD \
  --vpc-security-group-ids $GRC_SG \
  --db-subnet-group-name meru-db-subnet-group \
  --backup-retention-period 30 \
  --multi-az false \
  --publicly-accessible false \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

echo "✅ GRC RDS created: $GRC_RDS_ENDPOINT"

echo ""
echo "==========================================="
echo "Step 4: Create S3 Buckets"
echo "==========================================="

# Create S3 buckets
aws s3 mb s3://meru-documents --region $AWS_REGION || true
aws s3 mb s3://immigration-documents --region $AWS_REGION || true
aws s3 mb s3://grc-documents --region $AWS_REGION || true

echo "✅ S3 buckets created"

# Configure S3 buckets (enable encryption, versioning)
for BUCKET in meru-documents immigration-documents grc-documents; do
  aws s3api put-bucket-versioning \
    --bucket $BUCKET \
    --versioning-configuration Status=Enabled \
    --region $AWS_REGION

  aws s3api put-bucket-encryption \
    --bucket $BUCKET \
    --server-side-encryption-configuration AES256=true \
    --region $AWS_REGION
done

echo "✅ S3 buckets configured (encryption + versioning)"

echo ""
echo "==========================================="
echo "Step 5: Create EC2 Instances"
echo "==========================================="

# Create user-data script for EC2
cat > user-data.sh << 'EOF'
#!/bin/bash
# EC2 User Data for Meru Enterprise

# Update system
yum update -y || apt-get update -y

# Install Docker
yum install -y docker || apt-get install -y docker.io
systemctl start docker
systemctl enable docker
usermod -aG docker ec2-user || usermod -aG docker ubuntu

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create application directory
mkdir -p /var/www/meru-core
cd /var/www/meru-core

# Clone repository
git clone https://github.com/your-org/meru-core.git .

# Setup environment files
cat > .env.meru << ENV_EOF
DB_HOST=${DB_HOST}
DB_PORT=5432
DB_USERNAME=${DB_USERNAME}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=meru_core
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=meru-documents
JWT_SECRET=${JWT_SECRET}
OPENAI_API_KEY=${OPENAI_API_KEY}
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}
ENV_EOF

cat > .env.immigration << ENV_EOF
DB_HOST=${DB_HOST}
DB_PORT=5432
DB_USERNAME=${DB_USERNAME}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=immigration_core
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=immigration-documents
JWT_SECRET=${JWT_SECRET}
OPENAI_API_KEY=${OPENAI_API_KEY}
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}
ENV_EOF

cat > .env.grc << ENV_EOF
DB_HOST=${DB_HOST}
DB_PORT=5432
DB_USERNAME=${DB_USERNAME}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=grc_core
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=grc-documents
JWT_SECRET=${JWT_SECRET}
OPENAI_API_KEY=${OPENAI_API_KEY}
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}
ENV_EOF

# Start Docker containers (production only initially)
docker-compose -f docker-compose.meru.yml up -d
docker-compose -f docker-compose.immigration.yml up -d
docker-compose -f docker-compose.grc.yml up -d

echo "✅ Meru Enterprise EC2 setup completed!"
EOF

# Create Meru Core EC2
MERU_EC2_ID=$(aws ec2 run-instances \
  --image-id $EC2_AMI \
  --count 1 \
  --instance-type $EC2_INSTANCE_TYPE \
  --key-name $KEY_NAME \
  --security-group-ids $MERU_SG \
  --subnet-id $(echo $SUBNET_IDS | cut -d' ' -f1) \
  --user-data file://user-data.sh \
  --iam-instance-profile meru-enterprise-role \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=meru-core-prod},{Key=Vertical,Value=meru},{Key=Environment,Value=production},{Key=Project,Value=meru-enterprise}]' \
  --output text)

echo "✅ Meru Core EC2 created: $MERU_EC2_ID"

# Wait for EC2 to be running
aws ec2 wait instance-running \
  --instance-ids $MERU_EC2_ID

# Get EC2 public IP
MERU_EC2_IP=$(aws ec2 describe-instances \
  --instance-ids $MERU_EC2_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "✅ Meru Core EC2 is running at: $MERU_EC2_IP"

# Create Immigration EC2
IMM_EC2_ID=$(aws ec2 run-instances \
  --image-id $EC2_AMI \
  --count 1 \
  --instance-type $EC2_INSTANCE_TYPE \
  --key-name $KEY_NAME \
  --security-group-ids $IMMIGRATION_SG \
  --subnet-id $(echo $SUBNET_IDS | cut -d' ' -f2) \
  --user-data file://user-data.sh \
  --iam-instance-profile meru-enterprise-role \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=immigration-prod},{Key=Vertical,Value=immigration},{Key=Environment,Value=production},{Key=Project,Value=meru-enterprise}]' \
  --output text)

echo "✅ Immigration EC2 created: $IMM_EC2_ID"

# Wait for EC2 to be running
aws ec2 wait instance-running \
  --instance-ids $IMM_EC2_ID

# Get EC2 public IP
IMM_EC2_IP=$(aws ec2 describe-instances \
  --instance-ids $IMM_EC2_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "✅ Immigration EC2 is running at: $IMM_EC2_IP"

# Create GRC EC2
GRC_EC2_ID=$(aws ec2 run-instances \
  --image-id $EC2_AMI \
  --count 1 \
  --instance-type $EC2_INSTANCE_TYPE \
  --key-name $KEY_NAME \
  --security-group-ids $GRC_SG \
  --subnet-id $(echo $SUBNET_IDS | cut -d' ' -f3) \
  --user-data file://user-data.sh \
  --iam-instance-profile meru-enterprise-role \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=grc-prod},{Key=Vertical,Value=grc},{Key=Environment,Value=production},{Key=Project,Value=meru-enterprise}]' \
  --output text)

echo "✅ GRC EC2 created: $GRC_EC2_ID"

# Wait for EC2 to be running
aws ec2 wait instance-running \
  --instance-ids $GRC_EC2_ID

# Get EC2 public IP
GRC_EC2_IP=$(aws ec2 describe-instances \
  --instance-ids $GRC_EC2_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "✅ GRC EC2 is running at: $GRC_EC2_IP"

echo ""
echo "==========================================="
echo "Step 6: Create Route 53 DNS Records"
echo "==========================================="

# Create hosted zones (if not exist)
MERU_ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='${DOMAIN_BASE}.'].Id" \
  --output text || echo "")

if [ -z "$MERU_ZONE_ID" ]; then
  MERU_ZONE_ID=$(aws route53 create-hosted-zone \
    --name $DOMAIN_BASE \
    --caller-reference $(date +%s) \
    --output text)
  echo "✅ Created hosted zone for $DOMAIN_BASE"
fi

IMM_ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='${IMMIGRATION_DOMAIN}.'].Id" \
  --output text || echo "")

if [ -z "$IMM_ZONE_ID" ]; then
  IMM_ZONE_ID=$(aws route53 create-hosted-zone \
    --name $IMMIGRATION_DOMAIN \
    --caller-reference $(date +%s) \
    --output text)
  echo "✅ Created hosted zone for $IMMIGRATION_DOMAIN"
fi

GRC_ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='${GRC_DOMAIN}.'].Id" \
  --output text || echo "")

if [ -z "$GRC_ZONE_ID" ]; then
  GRC_ZONE_ID=$(aws route53 create-hosted-zone \
    --name $GRC_DOMAIN \
    --caller-reference $(date +%s) \
    --output text)
  echo "✅ Created hosted zone for $GRC_DOMAIN"
fi

# Create DNS records
# Meru Core
aws route53 change-resource-record-sets \
  --hosted-zone-id $MERU_ZONE_ID \
  --change-batch '{
    "Changes": [
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "api.meru.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$MERU_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "staging-api.meru.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$MERU_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "dev-api.meru.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$MERU_EC2_IP'"}]
        }
      }
    ]
  }'

# Immigration
aws route53 change-resource-record-sets \
  --hosted-zone-id $IMM_ZONE_ID \
  --change-batch '{
    "Changes": [
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "api.immistack.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$IMM_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "staging-api.immistack.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$IMM_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "dev-api.immistack.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$IMM_EC2_IP'"}]
        }
      }
    ]
  }'

# GRC
aws route53 change-resource-record-sets \
  --hosted-zone-id $GRC_ZONE_ID \
  --change-batch '{
    "Changes": [
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "api.governancex.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$GRC_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "staging-api.governancex.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$GRC_EC2_IP'"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "dev-api.governancex.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'$GRC_EC2_IP'"}]
        }
      }
    ]
  }'

echo "✅ DNS records created for all verticals"

echo ""
echo "==========================================="
echo "Step 7: Request ACM Certificates"
echo "==========================================="

# Request wildcard certificates
MERU_CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.meru.com" \
  --subject-alternative-names "meru.com,*.meru.com" \
  --validation-method DNS \
  --output text)

echo "✅ Meru SSL certificate requested: $MERU_CERT_ARN"

IMM_CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.immistack.com" \
  --subject-alternative-names "immistack.com,*.immistack.com" \
  --validation-method DNS \
  --output text)

echo "✅ Immigration SSL certificate requested: $IMM_CERT_ARN"

GRC_CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.governancex.com" \
  --subject-alternative-names "governancex.com,*.governancex.com" \
  --validation-method DNS \
  --output text)

echo "✅ GRC SSL certificate requested: $GRC_CERT_ARN"

echo ""
echo "==========================================="
echo "Step 8: Store Credentials in Secrets Manager"
echo "==========================================="

# Store database credentials
aws secretsmanager create-secret \
  --name "rds/meru-core-prod" \
  --description "Meru Core Production Database" \
  --secret-string '{
    "host": "'$MERU_RDS_ENDPOINT'",
    "port": 5432,
    "username": "'$DB_USERNAME'",
    "password": "'$DB_PASSWORD'",
    "dbname": "meru_core",
    "ssl": true
  }'

aws secretsmanager create-secret \
  --name "rds/immigration-prod" \
  --description "Immigration Production Database" \
  --secret-string '{
    "host": "'$IMM_RDS_ENDPOINT'",
    "port": 5432,
    "username": "'$DB_USERNAME'",
    "password": "'$DB_PASSWORD'",
    "dbname": "immigration_core",
    "ssl": true
  }'

aws secretsmanager create-secret \
  --name "rds/grc-prod" \
  --description "GRC Production Database" \
  --secret-string '{
    "host": "'$GRC_RDS_ENDPOINT'",
    "port": 5432,
    "username": "'$DB_USERNAME'",
    "password": "'$DB_PASSWORD'",
    "dbname": "grc_core",
    "ssl": true
  }'

echo "✅ Database credentials stored in Secrets Manager"

echo ""
echo "==========================================="
echo "Step 9: Create IAM Role for EC2"
echo "==========================================="

# Create IAM role with required permissions
aws iam create-role \
  --role-name meru-enterprise-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "ec2.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }' \
  --output text

# Attach policy for S3 access
aws iam put-role-policy \
  --role-name meru-enterprise-role \
  --policy-name meru-s3-policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "s3:*"
        ],
        "Resource": [
          "arn:aws:s3:::meru-documents",
          "arn:aws:s3:::immigration-documents",
          "arn:aws:s3:::grc-documents"
        ]
      }
    ]
  }'

# Attach policy for Secrets Manager access
aws iam put-role-policy \
  --role-name meru-enterprise-role \
  --policy-name meru-secrets-policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue"
        ],
        "Resource": "*"
      }
    ]
  }'

# Attach instance profile
aws iam create-instance-profile \
  --instance-profile-name meru-enterprise-profile \
  --output text

aws iam add-role-to-instance-profile \
  --instance-profile-name meru-enterprise-profile \
  --role-name meru-enterprise-role

echo "✅ IAM role created and configured"

echo ""
echo "==========================================="
echo "✅ Meru Enterprise Setup Complete!"
echo "==========================================="
echo ""
echo "Infrastructure Created:"
echo "  ┌────────────────────────────────────────────┐"
echo "  │ EC2 Instances:                           │"
echo "  │   - Meru Core:     $MERU_EC2_IP      │"
echo "  │   - Immigration:    $IMM_EC2_IP      │"
echo "  │   - GRC:          $GRC_EC2_IP      │"
echo "  │                                         │"
echo "  │ RDS Databases:                          │"
echo "  │   - Meru Core:     $MERU_RDS_ENDPOINT│"
echo "  │   - Immigration:    $IMM_RDS_ENDPOINT  │"
echo "  │   - GRC:          $GRC_RDS_ENDPOINT  │"
echo "  │                                         │"
echo "  │ S3 Buckets:                            │"
echo "  │   - meru-documents                      │"
echo "  │   - immigration-documents                  │"
echo "  │   - grc-documents                        │"
echo "  └────────────────────────────────────────────┘"
echo ""
echo "Next Steps:"
echo "1. Configure DNS validation for ACM certificates"
echo "2. Set up GitHub Secrets for CI/CD"
echo "3. Push code to repository"
echo "4. CI/CD will auto-deploy to all 3 EC2s"
echo ""
echo "Cost Breakdown:"
echo "  - EC2 (3 × t3.medium):      $90/month"
echo "  - RDS (3 × t3.micro):       $75/month"
echo "  - S3 (3 buckets):            ~$7/month"
echo "  - Route 53:                   ~$3/month"
echo "  - ACM:                         $0 (free)"
echo "  - Secrets Manager:              ~$1.20/month"
echo "  - CloudWatch:                  ~$15/month"
echo "  =========================================="
echo "  TOTAL:                        ~$191/month"
echo ""
echo "SSH to instances:"
echo "  Meru Core:     ssh -i ${KEY_NAME}.pem ec2-user@$MERU_EC2_IP"
echo "  Immigration:    ssh -i ${KEY_NAME}.pem ec2-user@$IMM_EC2_IP"
echo "  GRC:          ssh -i ${KEY_NAME}.pem ec2-user@$GRC_EC2_IP"
echo ""

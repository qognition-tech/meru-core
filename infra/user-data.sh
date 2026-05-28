#!/bin/bash
# EC2 User Data Script for Meru Core Deployment

set -e

echo "🚀 Starting Meru Core EC2 setup..."

# Update system
echo "📦 Updating system packages..."
sudo yum update -y || sudo apt-get update -y

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash - || \
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -

sudo yum install -y nodejs || sudo apt-get install -y nodejs

# Install pnpm
echo "📦 Installing pnpm..."
npm install -g pnpm

# Install PM2 for process management
echo "📦 Installing PM2..."
npm install -g pm2

# Install Docker (for container builds)
echo "📦 Installing Docker..."
sudo yum install -y docker || sudo apt-get install -y docker.io
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user || sudo usermod -aG docker ubuntu

# Install Git
echo "📦 Installing Git..."
sudo yum install -y git || sudo apt-get install -y git

# Setup application directory
echo "📁 Setting up application directories..."
sudo mkdir -p /var/www/meru-dev
sudo mkdir -p /var/www/meru-staging
sudo mkdir -p /var/www/meru-core
sudo mkdir -p /var/www/backups
sudo mkdir -p /var/www/logs

# Set permissions
sudo chown -R ec2-user:ec2-user /var/www || sudo chown -R ubuntu:ubuntu /var/www

# Clone repository (only if doesn't exist)
if [ ! -d "/var/www/meru-dev" ] || [ ! -d "/var/www/meru-staging" ] || [ ! -d "/var/www/meru-core" ]; then
  echo "📥 Cloning repository..."
  cd /var/www
  git clone https://github.com/your-org/meru-core.git meru-dev
  git clone https://github.com/your-org/meru-core.git meru-staging
  git clone https://github.com/your-org/meru-core.git meru-core
fi

# Setup PM2 ecosystem file
echo "⚙️  Setting up PM2 ecosystem..."
cat > /var/www/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'meru-dev',
      script: './dist/main.js',
      cwd: '/var/www/meru-dev',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        VERTICAL: 'core',
      },
      error_file: '/var/www/logs/meru-dev-error.log',
      out_file: '/var/www/logs/meru-dev-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: '1G',
      watch: false,
    },
    {
      name: 'meru-staging',
      script: './dist/main.js',
      cwd: '/var/www/meru-staging',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'staging',
        PORT: 3000,
        VERTICAL: 'core',
      },
      error_file: '/var/www/logs/meru-staging-error.log',
      out_file: '/var/www/logs/meru-staging-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: '1G',
      watch: false,
    },
    {
      name: 'meru-core',
      script: './dist/main.js',
      cwd: '/var/www/meru-core',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        VERTICAL: 'core',
      },
      error_file: '/var/www/logs/meru-core-error.log',
      out_file: '/var/www/logs/meru-core-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: '1G',
      watch: false,
    },
  ],
};
EOF

# Configure log rotation
echo "📋 Setting up log rotation..."
sudo cat > /etc/logrotate.d/meru << 'EOF'
/var/www/logs/*.log {
  daily
  missingok
  rotate 14
  compress
  delaycompress
  notifempty
  create 0644 ec2-user ec2-user
  sharedscripts
  postrotate
    pm2 reload all
  endscript
}
EOF

# Setup cron jobs for backups and maintenance
echo "⏰ Setting up cron jobs..."
(crontab -l 2>/dev/null; echo "0 2 * * * cd /var/www/meru-core && /usr/local/bin/pnpm run migration:backup") | crontab -
(crontab -l 2>/dev/null; echo "0 3 * * 0 pm2 flush") | crontab -

# Configure firewall
echo "🔒 Configuring firewall..."
if command -v firewall-cmd &> /dev/null; then
  sudo firewall-cmd --permanent --add-service=http
  sudo firewall-cmd --permanent --add-service=https
  sudo firewall-cmd --permanent --add-port=3000/tcp
  sudo firewall-cmd --reload
elif command -v ufw &> /dev/null; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 3000/tcp
  sudo ufw enable
fi

# Setup health check endpoint
echo "❤️  Setting up health check..."
cat > /var/www/health-check.sh << 'EOF'
#!/bin/bash
HEALTH_URL="http://localhost:3000/api/v1/health"
MAX_RETRIES=3
RETRY_DELAY=5

for i in $(seq 1 $MAX_RETRIES); do
  if curl -f $HEALTH_URL > /dev/null 2>&1; then
    echo "✅ Health check passed"
    exit 0
  fi
  echo "❌ Health check failed (attempt $i/$MAX_RETRIES)"
  sleep $RETRY_DELAY
done

echo "❌ Health check failed after $MAX_RETRIES attempts"
exit 1
EOF

sudo chmod +x /var/www/health-check.sh

# Add to crontab
(crontab -l 2>/dev/null; echo "*/5 * * * * /var/www/health-check.sh") | crontab -

echo "✅ EC2 setup completed!"
echo "📝 Next steps:"
echo "   1. SSH into the instance"
echo "   2. cd /var/www/meru-{env}"
echo "   3. pnpm install"
echo "   4. pnpm run build"
echo "   5. pm2 start ecosystem.config.js"

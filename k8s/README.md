# FoodFast Kubernetes Manifests

## Directory Structure

```
k8s/
├── namespace.yaml         # Namespace definition
├── configmap.yaml         # Environment configuration
├── secrets.yaml           # Sensitive data (DB passwords, API keys)
├── persistent-volumes.yaml # PVC for databases and RabbitMQ
├── databases.yaml         # PostgreSQL deployments (userdb, productdb, orderdb, paymentdb)
├── rabbitmq.yaml          # RabbitMQ deployment
├── api-gateway.yaml       # API Gateway deployment & service
├── user-service.yaml      # User Service deployment & service
├── product-service.yaml   # Product Service deployment & service
├── order-service.yaml     # Order Service deployment & service
├── payment-service.yaml   # Payment Service deployment & service
├── email-service.yaml     # Email Service deployment & service
├── socket-gateway.yaml    # Socket Gateway (WebSocket) deployment & service
├── ingress.yaml           # Ingress rules for external access
├── hpa.yaml               # Horizontal Pod Autoscalers

└── README.md              # This file
```

## Prerequisites

1. **Kubernetes Cluster**: Minikube, Docker Desktop Kubernetes, or cloud provider (EKS, GKE, AKS)
2. **kubectl**: Kubernetes CLI tool
3. **Docker Images**: Build and push images to a registry

## Building Docker Images

Before deploying, build and push Docker images:

```bash
# From the server directory
cd server

# Build images
docker build -t foodfast/api-gateway:latest ./apps/api-gateway
docker build -t foodfast/user-service:latest ./apps/user-service
docker build -t foodfast/product-service:latest ./apps/product-service
docker build -t foodfast/order-service:latest ./apps/order-service
docker build -t foodfast/payment-service:latest ./apps/payment-service
docker build -t foodfast/email-service:latest ./apps/email-service
docker build -t foodfast/socket-gateway:latest ./apps/socket-gateway

# Push to registry (if using remote cluster)
docker push foodfast/api-gateway:latest
# ... push all other images
```

## Deployment

### Option 1: Using deployment scripts

**Windows (PowerShell):**
```powershell
cd k8s
.\deploy.ps1

# To delete and redeploy:
.\deploy.ps1 -DeleteFirst
```

**Linux/Mac:**
```bash
cd k8s
chmod +x deploy.sh
./deploy.sh
```

### Option 2: Manual deployment

```bash
# Apply in order
kubectl apply -f namespace.yaml
kubectl apply -f secrets.yaml
kubectl apply -f configmap.yaml
kubectl apply -f persistent-volumes.yaml
kubectl apply -f databases.yaml
kubectl apply -f rabbitmq.yaml

# Wait for databases to be ready
kubectl wait --for=condition=ready pod -l app=userdb -n foodfast --timeout=120s

# Deploy services
kubectl apply -f user-service.yaml
kubectl apply -f product-service.yaml
kubectl apply -f order-service.yaml
kubectl apply -f payment-service.yaml
kubectl apply -f email-service.yaml
kubectl apply -f socket-gateway.yaml
kubectl apply -f api-gateway.yaml

# Apply ingress and HPA
kubectl apply -f ingress.yaml
kubectl apply -f hpa.yaml
```

## Configuration

### Updating Secrets

Edit `secrets.yaml` with your production values:

```yaml
stringData:
  DB_PASSWORD: "your-secure-password"
  JWT_SECRET: "your-jwt-secret"
  STRIPE_SECRET_KEY: "sk_live_xxx"
  # ... other secrets
```

**Important**: Never commit real secrets to version control!

### Using External Secrets (Recommended for Production)

For production, use:
- AWS Secrets Manager
- HashiCorp Vault
- Kubernetes External Secrets Operator

## Accessing Services

### Local Development (Minikube)

1. Enable ingress:
   ```bash
   minikube addons enable ingress
   ```

2. Get Minikube IP:
   ```bash
   minikube ip
   ```

3. Add to hosts file:
   ```
   192.168.49.2  api.foodfast.local ws.foodfast.local rabbitmq.foodfast.local
   ```

### Port Forwarding (Alternative)

```bash
# API Gateway
kubectl port-forward svc/api-gateway 8743:8743 -n foodfast

# RabbitMQ Management
kubectl port-forward svc/rabbitmq 15672:15672 -n foodfast
```

## Monitoring

### Check Pod Status
```bash
kubectl get pods -n foodfast
kubectl describe pod <pod-name> -n foodfast
kubectl logs <pod-name> -n foodfast
```

### Check Services
```bash
kubectl get svc -n foodfast
kubectl get endpoints -n foodfast
```

### Check HPA
```bash
kubectl get hpa -n foodfast
kubectl describe hpa api-gateway-hpa -n foodfast
```

## Scaling

### Manual Scaling
```bash
kubectl scale deployment api-gateway --replicas=5 -n foodfast
```

### HPA Configuration
Edit `hpa.yaml` to adjust:
- `minReplicas`: Minimum pods
- `maxReplicas`: Maximum pods
- `averageUtilization`: CPU/Memory threshold

## Cleanup

```bash
# Delete all resources
kubectl delete namespace foodfast

# Or delete specific resources
kubectl delete -f .
```

## Troubleshooting

### Pods not starting
```bash
kubectl describe pod <pod-name> -n foodfast
kubectl logs <pod-name> -n foodfast --previous
```

### Database connection issues
```bash
# Check if DB is running
kubectl exec -it <userdb-pod> -n foodfast -- pg_isready -U postgres

# Check DB logs
kubectl logs <userdb-pod> -n foodfast
```

### Service discovery issues
```bash
# Check endpoints
kubectl get endpoints -n foodfast

# Test DNS
kubectl run -it --rm debug --image=busybox -n foodfast -- nslookup userdb
```

## Service Ports

| Service | Port | Type |
|---------|------|------|
| API Gateway | 8743 | LoadBalancer |
| User Service | 3001 | ClusterIP |
| Product Service | 3002 | ClusterIP |
| Order Service | 3003 | ClusterIP |
| Payment Service | 3004 | ClusterIP |
| Email Service | 3005 | ClusterIP |
| Socket Gateway | 4000 | ClusterIP |
| RabbitMQ AMQP | 5672 | ClusterIP |
| RabbitMQ Mgmt | 15672 | ClusterIP |
| PostgreSQL DBs | 5432 | ClusterIP |

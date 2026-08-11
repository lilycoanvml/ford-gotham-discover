#!/usr/bin/env bash
# ── Deploy to Google Cloud Run ──────────────────────────────────────────
# Ford "Discover Your Next You" (Gotham reveal) — brand-new service.
#
# Usage: ./deploy.sh [project-id] [region]
# Example: ./deploy.sh vml-map-xd-ford us-central1
#
# Prerequisites (run once, in the TARGET project):
#   gcloud auth login
#   gcloud config set project vml-map-xd-ford
#   gcloud auth configure-docker us-central1-docker.pkg.dev
#   gcloud services enable run.googleapis.com artifactregistry.googleapis.com
#   gcloud secrets create gemini-api-key --replication-policy=automatic
#   echo -n "YOUR_KEY" | gcloud secrets versions add gemini-api-key --data-file=-

set -euo pipefail

# Defaults to the Ford project; override by passing a project id as $1.
PROJECT_ID="${1:-${GCP_PROJECT_ID:-vml-map-xd-ford}}"
REGION="${2:-us-central1}"
SERVICE_NAME="ford-gotham-discover"
REPO="ford-gotham-discover"
IMAGE_URL="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/app"

echo "▶ Project : $PROJECT_ID"
echo "▶ Service : $SERVICE_NAME"
echo "▶ Region  : $REGION"
echo "▶ Image   : $IMAGE_URL"
echo ""

# 1. Ensure Artifact Registry repo exists
gcloud artifacts repositories describe "$REPO" \
  --location="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null || \
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID"

# 2. Build image
echo "▶ Building Docker image..."
docker build -t "${IMAGE_URL}:latest" .

# 3. Push image
echo "▶ Pushing image..."
docker push "${IMAGE_URL}:latest"

# 4. Deploy to Cloud Run
echo "▶ Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image="${IMAGE_URL}:latest" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest" \
  --set-env-vars="GEMINI_MODEL=gemini-3.6-flash,GEMINI_REACTION_MODEL=gemini-3.5-flash-lite,GEMINI_TTS_MODEL=gemini-3.1-flash-live-preview,GEMINI_TTS_VOICE=Charon" \
  --project="$PROJECT_ID"

echo ""
echo "✓ Deployed. Service URL:"
gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format="value(status.url)"

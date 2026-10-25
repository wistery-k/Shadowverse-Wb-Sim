#!/bin/bash
# 月の費用が予算を超えたら、プロジェクトの課金を外して VM などをすべて止める仕組みを作る（cloud/README.md「費用の上限」）。
# Google Cloud の予算は通知しかできず、「利用額上限の適用」は VM を止めないので、予算の通知を Pub/Sub で関数に渡して課金を外す
# （Google の文書の「課金を無効にして使用を停止する」と同じ形）。
#
# Cloud Shell で一度だけ流す（プロジェクトのオーナーと、請求先アカウントの管理者の権限が要る）:
#   P=<プロジェクト ID> AMOUNT=30USD bash cloud/setup-billing-cap.sh
# AMOUNT は請求先アカウントの通貨で書く（円の請求先アカウントなら AMOUNT=4500JPY のように）。
#
# 予算 svwb-cap（AMOUNT、このプロジェクトだけ）→ Pub/Sub の billing-cap → 関数 billing-cap。予算の通知は 1 日に何度か届き、
# 月の初めからの費用が予算を超えていれば、関数がプロジェクトから請求先アカウントを外す。
# - 費用の反映には数時間の遅れがあるので、止まるのは超えてから数時間後（その間の分は超える）
# - 課金が外れると VM は止まる。Google の文書によれば、リソースが消えることもある（結果は毎回共有フォルダへ取り出しておく）
# - 戻すとき: 予算を上げてから（同じ月のうちは費用が予算を超えたままで、次の通知でまた外れる）、
#   お支払い →「プロジェクトの管理」でこのプロジェクトに請求先アカウントをつなぎ直す
set -euo pipefail
P=${P:?P=<プロジェクト ID> を付けて流す}
AMOUNT=${AMOUNT:-30USD}
REGION=${REGION:-us-central1}
TOPIC=billing-cap
SA=billing-cap@$P.iam.gserviceaccount.com

gcloud config set project "$P" --quiet
ACC=$(gcloud billing projects describe "$P" --format='value(billingAccountName)' | sed 's|^billingAccounts/||')
[ -n "$ACC" ] || { echo "プロジェクト $P に請求先アカウントがつながっていません"; exit 1; }
echo "== API を有効にする"
gcloud services enable cloudbilling.googleapis.com billingbudgets.googleapis.com pubsub.googleapis.com \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  eventarc.googleapis.com

echo "== Pub/Sub のトピックと、関数のサービスアカウント"
gcloud pubsub topics describe "$TOPIC" > /dev/null 2>&1 || gcloud pubsub topics create "$TOPIC"
# 予算の通知を送る Google のサービスアカウントに、トピックへの書き込みを許す
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member=serviceAccount:billing-budget-alert@system.gserviceaccount.com --role=roles/pubsub.publisher > /dev/null
gcloud iam service-accounts describe "$SA" > /dev/null 2>&1 ||
  gcloud iam service-accounts create billing-cap --display-name="予算を超えたら課金を外す"
# 課金を外す権限（プロジェクトの課金の管理者）と、Pub/Sub から関数を呼ぶ権限
for role in roles/billing.projectManager roles/run.invoker roles/eventarc.eventReceiver; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role="$role" --condition=None --quiet > /dev/null
done

echo "== 関数 billing-cap を作る"
D=$(mktemp -d)
cat > "$D/main.py" << 'PY'
import base64
import json
import os

import functions_framework
from google.cloud import billing_v1

PROJECT = os.environ["CAP_PROJECT"]


@functions_framework.cloud_event
def stop_billing(event):
    msg = json.loads(base64.b64decode(event.data["message"]["data"]).decode("utf-8"))
    cost = float(msg.get("costAmount", 0))
    budget = float(msg.get("budgetAmount", 0))
    unit = msg.get("currencyCode", "")
    if budget <= 0 or cost <= budget:
        print(f"上限内: {cost} / {budget} {unit}")
        return
    client = billing_v1.CloudBillingClient()
    name = f"projects/{PROJECT}"
    if not client.get_project_billing_info(name=name).billing_enabled:
        print(f"課金はもう外れています: {cost} / {budget} {unit}")
        return
    client.update_project_billing_info(
        name=name, project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name="")
    )
    print(f"予算を超えたので課金を外しました: {cost} / {budget} {unit}")
PY
cat > "$D/requirements.txt" << 'TXT'
functions-framework==3.*
google-cloud-billing==1.*
TXT
gcloud functions deploy billing-cap --gen2 --region="$REGION" --runtime=python312 --source="$D" \
  --entry-point=stop_billing --trigger-topic="$TOPIC" --run-service-account="$SA" --trigger-service-account="$SA" \
  --set-env-vars="CAP_PROJECT=$P" --max-instances=1 --quiet
rm -rf "$D"

echo "== 予算 svwb-cap（$AMOUNT）"
if gcloud billing budgets list --billing-account="$ACC" --format='value(displayName)' | grep -qx svwb-cap; then
  echo "予算 svwb-cap はもうあります（額を変えるときはコンソールのお支払い → 予算とアラート）"
else
  gcloud billing budgets create --billing-account="$ACC" --display-name=svwb-cap --budget-amount="$AMOUNT" \
    --filter-projects="projects/$P" --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 --notifications-rule-pubsub-topic="projects/$P/topics/$TOPIC" ||
    { echo "予算を作れませんでした。通貨が違うときは AMOUNT=4500JPY のように請求先アカウントの通貨で"; exit 1; }
fi

echo "== 試し: 予算内の通知を送る（課金は外れない）"
NUM=${AMOUNT%%[A-Za-z]*}
CUR=${AMOUNT##*[0-9.]}
gcloud pubsub topics publish "$TOPIC" \
  --message="{\"budgetDisplayName\":\"test\",\"costAmount\":0.0,\"budgetAmount\":$NUM,\"currencyCode\":\"$CUR\"}" > /dev/null
echo "1 分ほど後に次を流し、「上限内: 0.0 / $NUM $CUR」（額は 4500.0 のように小数で出る）と出ればよい:"
echo "  gcloud functions logs read billing-cap --region $REGION --gen2 --limit 5"

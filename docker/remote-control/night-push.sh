#!/bin/sh
# 前の名前（結果の pushは queue-push.sh に替えた。docs/queue.md）。前に出した券の 1 行がこの名前を使うので、
# 前のやり方（券と go）を外すときに一緒に消す。
exec "$(cd "$(dirname "$0")" && pwd)/queue-push.sh" "$@"

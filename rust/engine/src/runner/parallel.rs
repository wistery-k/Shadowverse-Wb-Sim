//! 独立した仕事（1 試合ずつ）を、CPU のコア数だけのスレッドで並列に行う（TypeScript 版 scripts/parallel.ts の parallelMap）。
//!
//! 並列数は環境変数 THREADS（既定は CPU のコア数。1 なら並列にしない）。結果は items と同じ順に並ぶ。
//! 各仕事がシードで決まっていれば、並列数によらず同じ結果になる（AI のメモ等のスレッドごとの状態は、試合の始めに捨てる）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

/// 並列数（環境変数 THREADS、既定は CPU のコア数）
pub fn thread_count() -> usize {
    match std::env::var("THREADS") {
        Ok(v) => v.parse::<usize>().ok().filter(|&n| n >= 1).unwrap_or(1),
        Err(_) => std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
    }
}

/// items の各要素に run を適用した結果を、items と同じ順で返す（並列に行う）。
/// on_done は呼び出し元のスレッドで、仕事が 1 つ終わるたびに（終わった順に）呼ばれる（終わった数・全体の数・結果・番号）
pub fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    run: impl Fn(&T, usize) -> R + Sync,
    mut on_done: impl FnMut(usize, usize, &R, usize),
) -> Vec<R> {
    let total = items.len();
    let threads = thread_count().min(total);
    let mut results: Vec<Option<R>> = (0..total).map(|_| None).collect();
    if threads <= 1 {
        for (i, item) in items.iter().enumerate() {
            let r = run(item, i);
            on_done(i + 1, total, &r, i);
            results[i] = Some(r);
        }
    } else {
        let next = AtomicUsize::new(0);
        let (tx, rx) = mpsc::channel::<(usize, R)>();
        std::thread::scope(|scope| {
            for _ in 0..threads {
                let tx = tx.clone();
                let (next, run) = (&next, &run);
                scope.spawn(move || loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    if tx.send((i, run(&items[i], i))).is_err() {
                        break;
                    }
                });
            }
            drop(tx);
            for (done, (i, r)) in rx.iter().enumerate() {
                on_done(done + 1, total, &r, i);
                results[i] = Some(r);
            }
        });
    }
    results
        .into_iter()
        .map(|r| r.expect("仕事の結果がありません（スレッドが途中で止まった）"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_order_as_items() {
        let items: Vec<u64> = (0..50).collect();
        let mut seen = 0;
        let out = parallel_map(
            &items,
            |x, i| x * 2 + i as u64,
            |done, total, _, _| {
                seen = done;
                assert_eq!(total, 50);
            },
        );
        assert_eq!(seen, 50);
        assert_eq!(out, (0..50).map(|x| x * 3).collect::<Vec<u64>>());
    }
}

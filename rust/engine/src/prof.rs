//! 処理ごとの時間の計測（`--features profile` でビルドしたときだけ働く。`svwb profile`、runner/profile.rs）。
//!
//! 測りたい処理の始めに `let _p = prof::scope(Sec::X);` を置くと、その処理を抜けるまでの時間を、
//! 呼び出しの入れ子（どの処理の中で呼ばれたか）ごとに足す。同じ処理でも、自分のターンのビームの中と
//! 相手のターンの読みの中では別に数える。時間はスレッドごとに数え、`take` で取り出して空にする。
//!
//! feature を付けないビルドでは `scope` は中身の無い値を返すだけで、何もしない（消えるので速さは変わらない）。
//! 付けたビルドでは 1 回あたり数十ナノ秒かかるので、合計は少し長く出る（どれだけ長くなったかは svwb profile が出す）。

/// 測る処理の種類
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Sec {
    /// AI が 1 手を選ぶ（runner/profile.rs が choose_action を囲む）
    Think,
    /// マリガン
    Mulligan,
    /// リーサル探索（find_lethal。前に見つけた手順の続きも含む）
    Lethal,
    /// リーサル探索のビーム（search_lethal）
    LethalBeam,
    /// リーサル探索の全探索（search_exact_lethal）
    LethalExact,
    /// 与えうるダメージの上限（damage_bound）
    DamageBound,
    /// 決定化（見えない情報の並べ直し）
    Determinize,
    /// ターン末までのビームサーチ（turn_end_bests。自分のターンの読みと相手のターンの読みの両方）
    Beam,
    /// ターン末の点数の上位を、相手のターンまで読み直す（plan_turn の読み直し）
    Rescore,
    /// 相手のターンを打つ（read_once の中の simulate_opponent_turn）
    OppTurn,
    /// 貪欲法で 1 手選ぶ（choose_greedy）
    Greedy,
    /// ビームで展開する手の一覧（Planner::expand。合法手と、下位互換の攻撃・手札の同じカードを除く）
    Expand,
    /// ビームの子の点数（Planner の score・end_score）
    Score,
    /// ビームの子を並べて幅まで絞る（並べ替えと同じ局面の除き）
    Select,
    /// 同じ局面の判定（TurnOrderSet::add）
    SameState,
    /// 並びを打ち直して局面を作る（Planner::steps_of）
    StepsOf,
    /// 合流する相打ちを打ち尽くす（settle_converging_trades_with）
    Settle,
    /// ターン終了時の処理を進める（resolve_turn_end）
    TurnEnd,
    /// 手で作った評価（evaluate_with）
    Eval,
    /// 学習した補正（value_net_eval）
    ValueNet,
    /// 合法手の一覧（legal_actions）
    Legal,
    /// 手を打つ（apply_legal。局面の複製と効果の解決）
    Apply,
    /// 局面の複製（apply_legal の中）
    Clone,
}

impl Sec {
    /// 表に出す名前
    pub fn label(self) -> &'static str {
        match self {
            Sec::Think => "思考",
            Sec::Mulligan => "マリガン",
            Sec::Lethal => "リーサル探索",
            Sec::LethalBeam => "リーサル探索のビーム",
            Sec::LethalExact => "リーサル探索の全探索",
            Sec::DamageBound => "与えうるダメージの上限",
            Sec::Determinize => "決定化",
            Sec::Beam => "ビーム",
            Sec::Rescore => "読み直し",
            Sec::OppTurn => "相手のターン",
            Sec::Greedy => "貪欲法",
            Sec::Expand => "展開する手",
            Sec::Score => "子の採点",
            Sec::Select => "幅まで絞る",
            Sec::SameState => "同じ局面の判定",
            Sec::StepsOf => "並びの打ち直し",
            Sec::Settle => "合流する相打ち",
            Sec::TurnEnd => "ターン終了時の処理",
            Sec::Eval => "手で作った評価",
            Sec::ValueNet => "学習した補正",
            Sec::Legal => "合法手",
            Sec::Apply => "手を打つ",
            Sec::Clone => "局面の複製",
        }
    }

    /// JSON に書く名前
    pub fn key(self) -> &'static str {
        match self {
            Sec::Think => "think",
            Sec::Mulligan => "mulligan",
            Sec::Lethal => "lethal",
            Sec::LethalBeam => "lethalBeam",
            Sec::LethalExact => "lethalExact",
            Sec::DamageBound => "damageBound",
            Sec::Determinize => "determinize",
            Sec::Beam => "beam",
            Sec::Rescore => "rescore",
            Sec::OppTurn => "oppTurn",
            Sec::Greedy => "greedy",
            Sec::Expand => "expand",
            Sec::Score => "score",
            Sec::Select => "select",
            Sec::SameState => "sameState",
            Sec::StepsOf => "stepsOf",
            Sec::Settle => "settle",
            Sec::TurnEnd => "turnEnd",
            Sec::Eval => "eval",
            Sec::ValueNet => "valueNet",
            Sec::Legal => "legal",
            Sec::Apply => "apply",
            Sec::Clone => "clone",
        }
    }
}

/// 呼び出しの入れ子（外側から）ごとの [時間（ナノ秒）, 回数]
pub type Profile = std::collections::BTreeMap<Vec<Sec>, [u64; 2]>;

/// feature profile でビルドしたか
pub const ENABLED: bool = cfg!(feature = "profile");

#[cfg(feature = "profile")]
mod imp {
    use super::{Profile, Sec};
    use std::cell::RefCell;
    use std::time::Instant;

    struct Node {
        sec: Sec,
        parent: usize,
        children: Vec<usize>,
        ns: u64,
        calls: u64,
    }

    /// 呼び出しの木。nodes[0] は根（どの処理の中でもない）
    struct Tree {
        nodes: Vec<Node>,
        cur: usize,
    }

    thread_local! {
        static TREE: RefCell<Tree> = const { RefCell::new(Tree { nodes: Vec::new(), cur: 0 }) };
    }

    /// 測っている処理（抜けるときに時間を足す）
    pub struct Scope {
        node: usize,
        start: Instant,
    }

    #[inline]
    pub fn scope(sec: Sec) -> Scope {
        let node = TREE.with(|t| {
            let mut t = t.borrow_mut();
            if t.nodes.is_empty() {
                t.nodes.push(Node {
                    sec: Sec::Think,
                    parent: 0,
                    children: Vec::new(),
                    ns: 0,
                    calls: 0,
                });
            }
            let cur = t.cur;
            let found = t.nodes[cur]
                .children
                .iter()
                .copied()
                .find(|&c| t.nodes[c].sec == sec);
            let c = match found {
                Some(c) => c,
                None => {
                    let c = t.nodes.len();
                    t.nodes.push(Node {
                        sec,
                        parent: cur,
                        children: Vec::new(),
                        ns: 0,
                        calls: 0,
                    });
                    t.nodes[cur].children.push(c);
                    c
                }
            };
            t.cur = c;
            c
        });
        Scope {
            node,
            start: Instant::now(),
        }
    }

    impl Drop for Scope {
        #[inline]
        fn drop(&mut self) {
            let ns = self.start.elapsed().as_nanos() as u64;
            TREE.with(|t| {
                let mut t = t.borrow_mut();
                let n = &mut t.nodes[self.node];
                n.ns += ns;
                n.calls += 1;
                t.cur = n.parent;
            });
        }
    }

    /// このスレッドで測った分を取り出して空にする（測っている処理の外で呼ぶ）
    pub fn take() -> Profile {
        TREE.with(|t| {
            let mut t = t.borrow_mut();
            assert_eq!(t.cur, 0, "prof::take は測っている処理の外で呼びます");
            let mut out = Profile::new();
            for i in 1..t.nodes.len() {
                let mut path = Vec::new();
                let mut j = i;
                while j != 0 {
                    path.push(t.nodes[j].sec);
                    j = t.nodes[j].parent;
                }
                path.reverse();
                let n = &t.nodes[i];
                if n.calls > 0 {
                    out.insert(path, [n.ns, n.calls]);
                }
            }
            t.nodes.clear();
            t.cur = 0;
            out
        })
    }
}

#[cfg(not(feature = "profile"))]
mod imp {
    use super::{Profile, Sec};

    /// 測らないビルドの印（何もしない）
    pub struct Scope;

    #[inline(always)]
    pub fn scope(_: Sec) -> Scope {
        Scope
    }

    pub fn take() -> Profile {
        Profile::new()
    }
}

pub use imp::{scope, take, Scope};

/// a に b を足す
pub fn merge(a: &mut Profile, b: &Profile) {
    for (k, v) in b {
        let e = a.entry(k.clone()).or_insert([0, 0]);
        e[0] += v[0];
        e[1] += v[1];
    }
}

#[cfg(all(test, feature = "profile"))]
mod tests {
    use super::*;

    #[test]
    fn nested_scopes_are_counted_by_path() {
        let _ = take();
        {
            let _a = scope(Sec::Think);
            for _ in 0..3 {
                let _b = scope(Sec::Beam);
                let _c = scope(Sec::Eval);
            }
            let _d = scope(Sec::Eval);
        }
        let p = take();
        assert_eq!(p[&vec![Sec::Think]][1], 1);
        assert_eq!(p[&vec![Sec::Think, Sec::Beam]][1], 3);
        assert_eq!(p[&vec![Sec::Think, Sec::Beam, Sec::Eval]][1], 3);
        assert_eq!(p[&vec![Sec::Think, Sec::Eval]][1], 1);
        assert!(p[&vec![Sec::Think]][0] >= p[&vec![Sec::Think, Sec::Beam]][0]);
        assert!(take().is_empty());
    }
}

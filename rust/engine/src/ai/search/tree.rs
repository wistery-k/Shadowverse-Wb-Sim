//! 自分のターンの木の探索（`tree`、2026-11-05）。層を作るビームの代わりに、採点した局面の数の予算の中で、次に広げる局面を 1 つずつ選ぶ。
//!
//! どの形も、深さ 1 の局面（根のすべての手。ビームと同じく最初の手の候補を落とさない）から始め、選んだ局面の子をすべて採点して足す。
//! 同じ局面（turnOrderEqual）はターン全体でまとめ、点数の高いほうを広げる（低いほうは終局面の候補には残す）。
//! 広げたかどうかに依らず、採点したすべての局面がそこでターンを終える候補になる。予算に達するか、下の止め方に当たったら止める。
//! 勝ちの点（1e5 以上）の並びが見つかったら止める。
//!
//! - `a0`: 楽観の値（そこで終えた点数 v ＋ 伸びしろの上側 u。ai/upper.rs の表）の高い局面から広げる（山は 1 つ）。
//!   残った局面の楽観の値がどれも見つけた最善以下になったら止める（stop）
//! - `bstar`: 最初の手ごとに、その下で見つけた最善 P（悲観）と、まだ広げていない局面の楽観の値の最大 O を持つ。
//!   P の上位 k の最初の手の P がどれも外の最初の手の O 以上で（区別がつく）、上位 k のどれも O − P ≤ eps なら止める（stop）。
//!   区別がつかなければ、上位 k のうち P が最も低い手（P を上げる）か、外で O が最も高い手（O を下げる）の、O − P の大きいほうを広げる。
//!   区別がついていれば、上位 k のうち O − P が最も大きい手を広げる
//! - `mcts`: 根から子を PUCT（値は、その下で見つけた最善の点数を局面の点数の幅で割ったもの。平均ではなく最大を戻す。
//!   事前の重みは同じ親の子の (v + 見込み) / temp の softmax）で選んで降り、広げていない局面に着いたら子をすべて採点して戻す。プレイアウトはしない
//!
//! - `lazy`（案 A'。a0 だけ）: 子は正確に採点せず、下限と上限のネットワーク（ai/bounds.rs）で予想した点数 v̂ と伸びしろの上側 û で
//!   山に入れる。山から出したときに初めて正確に採点し（そこで終えた点数として終局面の候補になるのは正確に採点した局面だけ）、
//!   v + û が山の次の局面より低くなれば山に戻す。先へ広げられない子（終わった・相手の選択待ち・深さの上限）はその場で正確に採点する。
//!   予算と途中の最善の予算は、正確に採点した数と予想しただけの数の和で数える
//!
//! 予算ごとの途中の最善（最初の手ごと）を start_tree_marks・take_tree_marks で取り出せる（svwb beam-gap）。
//! docs/ai-notes.md「自分のターンの探索を B*・MCTS に」

use super::{Node, Planner, Prio};
use crate::ai::bounds::BoundsNet;
use crate::ai::keys::TurnOrderMap;
use crate::ai::upper::{UpperShape, UpperTable};
use crate::state::{Action, GameState, Phase};
use std::cell::{Cell, RefCell};
use std::collections::BinaryHeap;
use std::rc::Rc;
use std::sync::Arc;

/// 勝ちの点とみなす点数（この点の並びが見つかったら止める）
const WIN: f64 = 1e5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeMode {
    A0,
    BStar,
    Mcts,
}

impl TreeMode {
    pub fn from_name(s: &str) -> Option<TreeMode> {
        match s {
            "a0" => Some(TreeMode::A0),
            "bstar" => Some(TreeMode::BStar),
            "mcts" => Some(TreeMode::Mcts),
            _ => None,
        }
    }
}

/// 自分のターンの木の探索の設定（SearchOptions.tree。None なら層ごとのビーム）
#[derive(Clone)]
pub struct TreeSearch {
    pub mode: TreeMode,
    /// 採点した局面の数の予算（深さ 1 の局面を含む）
    pub budget: usize,
    /// 伸びしろの上側の表（a0・bstar。None なら u = 0）
    pub upper: Option<Arc<UpperTable>>,
    /// 表の値に掛ける倍率
    pub upper_scale: f64,
    /// 広げられる局面の伸びしろの上側の下限（楽観の値に少なくともこれだけの余裕を持たせる。とても大きくすると、どの局面も広げる）
    pub upper_min: f64,
    /// bstar で区別する上位の最初の手の数（今の読み直しの rescoreTop に合わせて 4）
    pub top_k: usize,
    /// bstar で、O − P がこれ以下の最初の手は決まったとみなす
    pub eps: f64,
    /// a0・bstar で、楽観の値で区別がついたら予算の前に止める
    pub stop: bool,
    /// mcts の探索の定数
    pub c_puct: f64,
    /// mcts の事前の重みの温度（点数の単位）
    pub temp: f64,
    /// 案 A'（a0 だけ）: 子を予想だけで山に入れ、正確な採点を山から出すまで後回しにする（下限と上限のネットワーク。upper の表は使わない）
    pub lazy: Option<Arc<BoundsNet>>,
}

impl Default for TreeSearch {
    fn default() -> Self {
        TreeSearch {
            mode: TreeMode::BStar,
            budget: 2000,
            upper: None,
            upper_scale: 1.0,
            upper_min: 0.0,
            top_k: 4,
            eps: 0.0,
            stop: true,
            c_puct: 1.0,
            temp: 5.0,
            lazy: None,
        }
    }
}

/// 予算に達した時点の、最初の手ごとの最善
pub struct TreeMark {
    /// 予算
    pub at: usize,
    /// その時点で正確に採点した局面の数（広げる局面 1 つ分だけ予算を越える。予算の前に止まったら止まった時点の数）
    pub scored: usize,
    /// その時点で予想だけした局面の数（lazy）
    pub predicted: usize,
    pub firsts: Vec<(Action, f64)>,
}

thread_local! {
    /// 途中の最善を書く予算と、書いたもの（svwb beam-gap。スレッドごと）
    static MARKS: RefCell<Option<(Vec<usize>, Vec<TreeMark>)>> = const { RefCell::new(None) };
    /// lazy で予想だけした局面の数（調べもの用。スレッドごと）
    static PREDICTED: Cell<u64> = const { Cell::new(0) };
}

/// このスレッドで lazy が予想だけした局面の数の累計
pub fn predicted_count() -> u64 {
    PREDICTED.with(|c| c.get())
}

/// このスレッドの次の木の探索で、予算 at（昇順）ごとの途中の最善を書く
pub fn start_tree_marks(at: Vec<usize>) {
    MARKS.with(|m| *m.borrow_mut() = Some((at, Vec::new())));
}

/// 書いた途中の最善を取り出し、書くのをやめる
pub fn take_tree_marks() -> Vec<TreeMark> {
    MARKS.with(|m| m.borrow_mut().take().map(|x| x.1).unwrap_or_default())
}

/// 探索の木（採点した局面すべて）
struct Tree {
    nodes: Vec<Node>,
    /// 最初の手の番号
    group: Vec<usize>,
    /// 楽観の値（広げられない局面は v）
    o: Vec<f64>,
    /// 伸びしろの上側
    u: Vec<f64>,
    /// 点数が正確な採点か（lazy で予想だけの局面は false）
    exact: Vec<bool>,
    /// v + 見込み（mcts の事前の重み）
    key: Vec<f64>,
    /// 広げられる局面か（終わっていない・自分の手番・深さの上限の前）
    open: Vec<bool>,
    /// 同じ局面の点数の高いものに置き換えた（広げない）
    dead: Vec<bool>,
    expanded: Vec<bool>,
    children: Vec<Vec<usize>>,
    visits: Vec<u32>,
    prior: Vec<f64>,
    /// その下で見つけた最善
    sub_best: Vec<f64>,
    /// その下にもう広げる局面が無い（mcts）
    done: Vec<bool>,
    seen: TurnOrderMap<(usize, f64)>,
    firsts: Vec<Action>,
    /// 最初の手ごとの最善（悲観 P）
    p_best: Vec<f64>,
    best: f64,
    scored: usize,
    predicted: usize,
    mark_at: Vec<usize>,
    marks: Vec<TreeMark>,
}

impl Tree {
    fn group_of(&mut self, a: &Action) -> usize {
        match self.firsts.iter().position(|f| f == a) {
            Some(g) => g,
            None => {
                self.firsts.push(a.clone());
                self.p_best.push(f64::NEG_INFINITY);
                self.firsts.len() - 1
            }
        }
    }

    /// 読んだ局面の数（正確に採点した数と予想だけした数の和）
    fn reads(&self) -> usize {
        self.scored + self.predicted
    }

    fn mark(&mut self) {
        while self.marks.len() < self.mark_at.len()
            && self.reads() >= self.mark_at[self.marks.len()]
        {
            let at = self.mark_at[self.marks.len()];
            self.push_mark(at);
        }
    }

    fn push_mark(&mut self, at: usize) {
        // 局面がすべて別の最初の手の同じ局面にまとめられた手は書かない
        let firsts = self
            .firsts
            .iter()
            .cloned()
            .zip(self.p_best.iter().copied())
            .filter(|(_, v)| v.is_finite())
            .collect();
        self.marks.push(TreeMark {
            at,
            scored: self.scored,
            predicted: self.predicted,
            firsts,
        });
    }

    fn won(&self) -> bool {
        self.best >= WIN
    }

    /// 最初の手 g の楽観の値（山のいちばん上の、まだ広げられる局面の楽観の値と P の大きいほう）
    fn optimistic(&self, g: usize, heap: &mut BinaryHeap<Prio>) -> f64 {
        while let Some(top) = heap.peek() {
            if self.dead[top.seq] || self.expanded[top.seq] {
                heap.pop();
            } else {
                return top.key.max(self.p_best[g]);
            }
        }
        self.p_best[g]
    }
}

impl<'a> Planner<'a> {
    /// tree: 根でターンを終える局面 terminals と深さ 1 の局面 start（すべて採点済み）から木の探索をし、採点したすべての局面を返す
    pub(super) fn tree_terminals(
        &mut self,
        terminals: Vec<Node>,
        start: Vec<Node>,
        ts: &TreeSearch,
    ) -> Vec<Node> {
        let mark_at = MARKS.with(|m| m.borrow().as_ref().map(|x| x.0.clone()));
        let mut t = Tree {
            nodes: Vec::new(),
            group: Vec::new(),
            o: Vec::new(),
            u: Vec::new(),
            exact: Vec::new(),
            key: Vec::new(),
            open: Vec::new(),
            dead: Vec::new(),
            expanded: Vec::new(),
            children: Vec::new(),
            visits: Vec::new(),
            prior: Vec::new(),
            sub_best: Vec::new(),
            done: Vec::new(),
            seen: TurnOrderMap::default(),
            firsts: Vec::new(),
            p_best: Vec::new(),
            best: f64::NEG_INFINITY,
            scored: terminals.len() + start.len(),
            predicted: 0,
            mark_at: mark_at.clone().unwrap_or_default(),
            marks: Vec::new(),
        };
        for n in terminals.into_iter().chain(start) {
            let g = t.group_of(&n.first);
            self.tree_add(&mut t, ts, n, g, None);
        }
        t.mark();
        if !t.won() {
            match ts.mode {
                TreeMode::A0 => self.tree_a0(&mut t, ts),
                TreeMode::BStar => self.tree_bstar(&mut t, ts),
                TreeMode::Mcts => self.tree_mcts(&mut t, ts),
            }
        }
        // 予算の前に止まったら、残りの予算の時点は止まった時点の最善
        while t.marks.len() < t.mark_at.len() {
            let at = t.mark_at[t.marks.len()];
            t.push_mark(at);
        }
        if mark_at.is_some() {
            let marks = std::mem::take(&mut t.marks);
            MARKS.with(|m| {
                if let Some(x) = m.borrow_mut().as_mut() {
                    x.1 = marks;
                }
            });
        }
        PREDICTED.with(|c| c.set(c.get() + t.predicted as u64));
        // 終局面の候補は正確に採点した局面だけ
        t.nodes
            .into_iter()
            .zip(t.exact)
            .filter(|(_, e)| *e)
            .map(|(n, _)| n)
            .collect()
    }

    /// 局面 s（深さ depth）から先へ広げられるか（終わっていない・自分の手番・深さの上限の前）
    fn tree_open(&self, s: &GameState, depth: u32) -> bool {
        let actor = s.pending.as_ref().map(|pd| pd.player()).unwrap_or(s.active);
        s.phase != Phase::Ended && actor == self.p && (depth as usize) < self.opts().max_depth
    }

    /// 局面 n（最初の手の番号 g）を木に足す。同じ局面があって点数が高くなければ足さない。
    /// predicted_u が Some なら n.value は予想（lazy）で、伸びしろの上側はその値
    fn tree_add(
        &self,
        t: &mut Tree,
        ts: &TreeSearch,
        n: Node,
        g: usize,
        predicted_u: Option<f64>,
    ) -> Option<usize> {
        let idx = t.nodes.len();
        // 同じ局面をもう広げていれば、点数の高いこの局面は終局面の候補にだけ足す（その先はもう採点してある）
        let mut known_after = false;
        if self.opts().dedup {
            let replaced = match t.seen.get_or_add(&n.state, (idx, n.value)) {
                Some(e) => {
                    if n.value <= e.1 {
                        return None;
                    }
                    let old = e.0;
                    *e = (idx, n.value);
                    Some(old)
                }
                None => None,
            };
            if let Some(old) = replaced {
                known_after = t.expanded[old];
                t.dead[old] = true;
                t.done[old] = true;
            }
        }
        let opts = self.opts();
        let p = self.p;
        let s: &GameState = &n.state;
        let open = !known_after && self.tree_open(s, n.depth);
        let pot = if open && predicted_u.is_none() && ts.lazy.is_none() {
            opts.potential.as_ref().map(|net| net.eval(s, p))
        } else {
            None
        };
        // 伸びしろの上側: lazy なら下限と上限のネットワーク（正確に採点した局面も）、無ければ表
        let u = if !open {
            0.0
        } else if let Some(u) = predicted_u {
            (ts.upper_scale * u).max(ts.upper_min)
        } else if let Some(net) = &ts.lazy {
            (ts.upper_scale * net.eval(s, p).1).max(ts.upper_min)
        } else if let Some(tb) = &ts.upper {
            (ts.upper_scale * tb.upper(&UpperShape::of(s, p, n.depth, pot))).max(ts.upper_min)
        } else {
            ts.upper_min
        };
        let v = n.value;
        let exact = predicted_u.is_none();
        if exact {
            t.p_best[g] = t.p_best[g].max(v);
            t.best = t.best.max(v);
        }
        t.group.push(g);
        t.o.push(v + u);
        t.u.push(u);
        t.exact.push(exact);
        t.key.push(v + opts.potential_weight * pot.unwrap_or(0.0));
        t.open.push(open);
        t.dead.push(false);
        t.expanded.push(false);
        t.children.push(Vec::new());
        t.visits.push(0);
        t.prior.push(0.0);
        t.sub_best.push(v);
        t.done.push(!open);
        t.nodes.push(n);
        Some(idx)
    }

    /// 局面 i の子をすべて採点して木に足し、足した子の添字を返す
    fn tree_expand(&mut self, t: &mut Tree, ts: &TreeSearch, i: usize) -> Vec<usize> {
        t.expanded[i] = true;
        let (st, first, path, depth): (Rc<GameState>, Action, usize, u32) = {
            let n = &t.nodes[i];
            (n.state.clone(), n.first.clone(), n.path, n.depth)
        };
        let g = t.group[i];
        let mut out = Vec::new();
        let mut next: Vec<(Rc<GameState>, usize)> = Vec::new();
        for a in self.expand(&st) {
            if matches!(a, Action::EndTurn) || !self.allowed(&st, &a) {
                continue;
            }
            next.clear();
            self.advance(&st, &a, Some(path), 0, &mut next);
            for (ns, np) in std::mem::take(&mut next) {
                // lazy なら、先へ広げられる子は予想だけ
                let (value, predicted_u) = match &ts.lazy {
                    Some(net) if self.tree_open(&ns, depth + 1) => {
                        t.predicted += 1;
                        let (v, u) = net.eval(&ns, self.p);
                        (v, Some(u))
                    }
                    _ => {
                        t.scored += 1;
                        (self.score(&ns), None)
                    }
                };
                let n = Node {
                    state: ns,
                    first: first.clone(),
                    value,
                    path: np,
                    depth: depth + 1,
                };
                if let Some(j) = self.tree_add(t, ts, n, g, predicted_u) {
                    out.push(j);
                }
            }
        }
        t.mark();
        out
    }

    fn tree_a0(&mut self, t: &mut Tree, ts: &TreeSearch) {
        let mut heap: BinaryHeap<Prio> = BinaryHeap::new();
        for i in 0..t.nodes.len() {
            if t.open[i] {
                heap.push(Prio {
                    key: t.o[i],
                    seq: i,
                });
            }
        }
        while let Some(Prio { key, seq: i }) = heap.pop() {
            if t.reads() >= ts.budget || t.won() {
                break;
            }
            if t.dead[i] || t.expanded[i] {
                continue;
            }
            let mut key = key;
            if !t.exact[i] {
                // lazy: 正確に採点し、山の次の局面より低くなれば山に戻す
                let v = self.score(&t.nodes[i].state);
                t.scored += 1;
                t.nodes[i].value = v;
                t.exact[i] = true;
                let g = t.group[i];
                t.p_best[g] = t.p_best[g].max(v);
                t.best = t.best.max(v);
                t.o[i] = v + t.u[i];
                t.mark();
                key = t.o[i];
                if heap.peek().is_some_and(|top| top.key > key) {
                    heap.push(Prio { key, seq: i });
                    continue;
                }
                if t.reads() >= ts.budget || t.won() {
                    break;
                }
            }
            if ts.stop && key <= t.best {
                break;
            }
            for j in self.tree_expand(t, ts, i) {
                if t.open[j] {
                    heap.push(Prio {
                        key: t.o[j],
                        seq: j,
                    });
                }
            }
        }
    }

    fn tree_bstar(&mut self, t: &mut Tree, ts: &TreeSearch) {
        let mut heaps: Vec<BinaryHeap<Prio>> =
            (0..t.firsts.len()).map(|_| BinaryHeap::new()).collect();
        for i in 0..t.nodes.len() {
            if t.open[i] {
                heaps[t.group[i]].push(Prio {
                    key: t.o[i],
                    seq: i,
                });
            }
        }
        let ng = heaps.len();
        let mut opt = vec![0.0; ng];
        let mut order: Vec<usize> = Vec::with_capacity(ng);
        while t.reads() < ts.budget && !t.won() {
            for (g, h) in heaps.iter_mut().enumerate() {
                opt[g] = t.optimistic(g, h);
            }
            order.clear();
            order.extend(0..ng);
            order.sort_by(|&a, &b| {
                t.p_best[b]
                    .partial_cmp(&t.p_best[a])
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.cmp(&b))
            });
            let k = ts.top_k.max(1).min(ng);
            let (top, rest) = order.split_at(k);
            let gap = |g: usize| opt[g] - t.p_best[g];
            let unresolved = |g: usize| gap(g) > ts.eps;
            // 外で O が最も高い手と、上位 k で P が最も低い手
            let rival = rest.iter().copied().max_by(|&a, &b| {
                opt[a]
                    .partial_cmp(&opt[b])
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.cmp(&a))
            });
            let low = top[k - 1];
            let separated = rival.is_none_or(|r| opt[r] <= t.p_best[low] + ts.eps);
            let pick = if !separated {
                let r = rival.expect("区別がつかないのは外に手があるとき");
                if unresolved(low) && gap(low) >= gap(r) {
                    low
                } else {
                    r
                }
            } else if let Some(g) =
                top.iter()
                    .copied()
                    .filter(|&g| unresolved(g))
                    .max_by(|&a, &b| {
                        gap(a)
                            .partial_cmp(&gap(b))
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then(b.cmp(&a))
                    })
            {
                g
            } else if ts.stop {
                break;
            } else {
                // 止めないなら、O − P の最も大きい手を広げ続ける
                match (0..ng).filter(|&g| unresolved(g)).max_by(|&a, &b| {
                    gap(a)
                        .partial_cmp(&gap(b))
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(b.cmp(&a))
                }) {
                    Some(g) => g,
                    None => break,
                }
            };
            // pick は O > P なので、山に広げられる局面がある
            let Some(Prio { seq: i, .. }) = heaps[pick].pop() else {
                break;
            };
            for j in self.tree_expand(t, ts, i) {
                if t.open[j] {
                    heaps[t.group[j]].push(Prio {
                        key: t.o[j],
                        seq: j,
                    });
                }
            }
        }
    }

    fn tree_mcts(&mut self, t: &mut Tree, ts: &TreeSearch) {
        let root: Vec<usize> = (0..t.nodes.len()).collect();
        set_priors(t, &root, ts.temp);
        // 点数の幅の下端（根の子の点数の最小。勝ち負けの点は外す）
        let lo = root
            .iter()
            .map(|&i| t.nodes[i].value)
            .filter(|v| v.abs() < WIN)
            .fold(f64::INFINITY, f64::min);
        let lo = if lo.is_finite() { lo } else { 0.0 };
        let mut root_visits: u32 = 0;
        let mut path: Vec<usize> = Vec::new();
        while t.reads() < ts.budget && !t.won() {
            let hi = t.best.min(WIN);
            let scale = (hi - lo).max(1.0);
            path.clear();
            // 降りる
            let mut kids: &[usize] = &root;
            let mut parent_visits = root_visits;
            loop {
                let pick = kids
                    .iter()
                    .copied()
                    .filter(|&c| !t.done[c])
                    .map(|c| {
                        let q = ((t.sub_best[c].clamp(lo, hi) - lo) / scale).clamp(0.0, 1.0);
                        let u = ts.c_puct * t.prior[c] * ((parent_visits + 1) as f64).sqrt()
                            / (1.0 + t.visits[c] as f64);
                        (c, q + u)
                    })
                    .max_by(|a, b| {
                        a.1.partial_cmp(&b.1)
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then(b.0.cmp(&a.0))
                    });
                let Some((c, _)) = pick else { break };
                path.push(c);
                if !t.expanded[c] {
                    break;
                }
                kids = &t.children[c];
                parent_visits = t.visits[c];
            }
            let Some(&leaf) = path.last() else {
                break; // 根の子がすべて広げ終わった
            };
            if !t.expanded[leaf] {
                if t.open[leaf] && !t.dead[leaf] {
                    let ch = self.tree_expand(t, ts, leaf);
                    set_priors(t, &ch, ts.temp);
                    for &c in &ch {
                        t.sub_best[leaf] = t.sub_best[leaf].max(t.sub_best[c]);
                    }
                    t.children[leaf] = ch;
                } else {
                    t.expanded[leaf] = true;
                }
            }
            // 戻す（最大と訪問回数と、その下に広げる局面が残っているか）
            for j in (0..path.len()).rev() {
                let x = path[j];
                t.visits[x] += 1;
                if j + 1 < path.len() {
                    let c = path[j + 1];
                    t.sub_best[x] = t.sub_best[x].max(t.sub_best[c]);
                }
                if t.expanded[x] && t.children[x].iter().all(|&c| t.done[c]) {
                    t.done[x] = true;
                }
            }
            root_visits += 1;
        }
    }
}

/// 同じ親の子 kids の事前の重み（(v + 見込み) / temp の softmax）
fn set_priors(t: &mut Tree, kids: &[usize], temp: f64) {
    let temp = temp.max(1e-6);
    let m = kids
        .iter()
        .map(|&c| t.key[c])
        .fold(f64::NEG_INFINITY, f64::max);
    let mut z = 0.0;
    for &c in kids {
        let e = ((t.key[c] - m) / temp).exp();
        t.prior[c] = e;
        z += e;
    }
    if z > 0.0 {
        for &c in kids {
            t.prior[c] /= z;
        }
    }
}

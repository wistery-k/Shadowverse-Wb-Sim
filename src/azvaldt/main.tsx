// アズヴォルト環境（前期のローテーション・能力調整後）のページの入口（azvaldt/index.html。CLAUDE.md「決定済みの前提」、ユーザーの依頼 2026-11-19）。
// 探索 AI の補正と見込みは R3（data/pools/azvaldt/。スターターの補正は取りに行かない）。画面のカードの表に前期のローテーションのカードを足す
import { selectNets } from "../engine";
import "../record/pool";
import { boot } from "../ui/boot";
import "../ui/style.css";
import { AzvaldtApp } from "./App";

selectNets("azvaldt");
boot(() => <AzvaldtApp />);

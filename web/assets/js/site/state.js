/* 前台共享状态（避免视图与入口之间的循环依赖） */
export const state = { site: { site: { name: "向明笔记" } }, router: null, openPalette: () => {} };
export const go = (path, opt) => state.router && state.router.go(path, opt);

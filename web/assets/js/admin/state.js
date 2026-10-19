/* 后台共享状态 */
export const adminState = { user: null, router: null };
export const go = (path, opt) => adminState.router && adminState.router.go(path, opt);

export const STATUS = {
  published: { label: "已发布", cls: "st-published" },
  pinned: { label: "置顶", cls: "st-pinned" },
  draft: { label: "草稿", cls: "st-draft" },
  scheduled: { label: "定时", cls: "st-scheduled" },
  trashed: { label: "回收站", cls: "st-trashed" },
};

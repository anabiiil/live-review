/**
 * Shared JSDoc types for LiveReview. This module has no runtime exports.
 */

/** @typedef {{type:'add'|'del'|'ctx', oldNo:number|null, newNo:number|null, text:string}} DiffLine */
/** @typedef {{header:string, lines:DiffLine[]}} Hunk */
/** @typedef {{path:string, oldPath:string|null, status:'added'|'modified'|'deleted'|'renamed',
 *   binary:boolean, hidden:boolean, large:boolean, hunks:Hunk[], patch:string}} FileDiff */
/** @typedef {{branch:string|null, detached:boolean, sha:string|null, empty:boolean,
 *   operation:null|'rebase'|'merge'}} HeadState */
/** @typedef {{sha:string, short:string, subject:string, author:string, date:string}} CommitSummary */
/** @typedef {{lineText:string, before:string[], after:string[]}} Anchor */
/** @typedef {{kind:'owner'|'reviewer', email:string, name:string|null}} Viewer */

export {};

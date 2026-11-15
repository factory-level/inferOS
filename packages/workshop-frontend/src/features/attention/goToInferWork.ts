/**
 * Leave for an InferWork link the server returned from `openAttentionItem`, which it validated
 * against this deployment's InferWork origins. Only ever called from a person's Open click: the
 * Workshop never navigates on its own. The link grants nothing; InferWork checks access again.
 */
export const goToInferWork = (url: string): void => {
  window.location.assign(url);
};

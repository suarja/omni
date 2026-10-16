export const REVIEW_CHANGED_CHANNEL = "omni:review-changed";

export interface ReviewEventsDesktopApi {
  onReviewChanged(listener: () => void): () => void;
}

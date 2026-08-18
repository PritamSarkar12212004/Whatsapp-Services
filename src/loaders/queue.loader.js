import campaignQueue from "../jobs/campaign.queue.js";

const initQueue = () => {
  campaignQueue.recoverPendingJobs().catch((err) =>
    console.error("[CRM Queue] recovery error:", err.message),
  );
};

export default initQueue;

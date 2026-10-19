import { createLogger } from "../logs/logger.js";

const log = createLogger("queue.loader");

import campaignQueue from "../jobs/campaign.queue.js";

const initQueue = () => {
  campaignQueue.recoverPendingJobs().catch((err) =>
    log.error("[CRM Queue] recovery error:", err.message),
  );
};

export default initQueue;

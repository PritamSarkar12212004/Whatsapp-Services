import campaignService from "../../../services/messaging/campaign.service.js";
import CampaignRecipient from "../../../models/messaging/campaignRecipient.model.js";

const getOwnerId = (req) => req.user?.userId;

const requireOwner = (req, res) => {
  const ownerId = getOwnerId(req);
  if (!ownerId) {
    return res
      .status(401)
      .json({ status: "error", message: "User not authenticated" });
  }
  return ownerId;
};

const campaignController = {
  /** GET /campaigns — list campaigns */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaigns = await campaignService.listCampaigns(ownerId, {
        status: req.query.status,
      });
      return res.status(200).json({ status: "success", data: campaigns });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns — create a campaign */
  async create(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.createCampaign(ownerId, req.body);
      return res.status(201).json({
        status: "success",
        message: "Campaign created",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /campaigns/:id — campaign details */
  async getOne(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.getCampaign(ownerId, req.params.id);
      return res.status(200).json({ status: "success", data: campaign });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** PATCH /campaigns/:id — update a campaign */
  async update(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.updateCampaign(
        ownerId,
        req.params.id,
        req.body,
      );
      return res.status(200).json({
        status: "success",
        message: "Campaign updated",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** DELETE /campaigns/:id — delete a campaign (draft/cancelled only) */
  async remove(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      await campaignService.deleteCampaign(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Campaign deleted",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /**
   * POST /campaigns/:id/preview
   * body: { contactId } or { phoneNumber }
   * Preview the rendered message for a single contact without sending.
   */
  async preview(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const identifier = req.body.contactId || req.body.phoneNumber;
      if (!identifier) {
        return res.status(400).json({
          status: "error",
          message: "contactId or phoneNumber is required",
        });
      }

      const result = await campaignService.previewMessage(ownerId, req.params.id, identifier);
      return res.status(200).json({
        status: "success",
        message: "Campaign message preview",
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /campaigns/:id/audience — preview the resolved audience */
  async audience(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const result = await campaignService.previewAudience(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns/:id/start — start sending */
  async start(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const result = await campaignService.startCampaign(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Campaign started",
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns/:id/pause — pause sending */
  async pause(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.pauseCampaign(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Campaign paused",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns/:id/resume — resume sending */
  async resume(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.resumeCampaign(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Campaign resumed",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns/:id/cancel — cancel campaign */
  async cancel(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.cancelCampaign(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Campaign cancelled",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /campaigns/:id/unschedule — cancel a dev campaign's schedule */
  async unschedule(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const campaign = await campaignService.unscheduleCampaign(
        ownerId,
        req.params.id,
      );
      return res.status(200).json({
        status: "success",
        message: "Campaign schedule cancelled",
        data: campaign,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /campaigns/:id/recipients — list recipients for a campaign */
  async recipients(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const skip = (page - 1) * limit;

      const query = { campaign: req.params.id };
      if (req.query.status) query.status = req.query.status;

      const [total, recipients] = await Promise.all([
        CampaignRecipient.countDocuments(query).exec(),
        CampaignRecipient.find(query)
          .populate("contact", "name phoneNumber")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .exec(),
      ]);

      return res.status(200).json({
        status: "success",
        data: recipients,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /campaigns/:id/stats — aggregate recipient statistics */
  async stats(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      // Verify ownership
      const campaign = await campaignService.getCampaign(ownerId, req.params.id);

      // Dev campaigns are live switches — report API-call stats instead of
      // recipient stats (they never send to an audience).
      if (campaign.devTemplate) {
        const devStats = await campaignService.getDevStats(
          ownerId,
          req.params.id,
        );
        return res.status(200).json({
          status: "success",
          data: { devStats, isDev: true },
        });
      }

      const aggregate = await campaignService.getRecipientStats(req.params.id);
      const byStatus = {};
      for (const entry of aggregate) {
        byStatus[entry._id] = entry.count;
      }

      return res.status(200).json({
        status: "success",
        data: { byStatus },
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default campaignController;

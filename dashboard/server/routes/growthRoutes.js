import {
  getActiveChannel,
  getChannelById,
  getAllChannels,
  validateGrowthABChannel,
  sanitizeChannel,
  updateChannel,
} from './channelsManager.js';
import { readCachedChannel } from './channel.js';
import {
  loadGrowthReport,
  generateGrowthReport,
  cohortReport,
} from '../growth/report.js';
import {
  loadChannelStrategy,
  generateChannelStrategy,
  updateChannelStrategy,
} from '../growth/strategy.js';
import {
  loadChannelIdeas,
  generateGrowthIdeas,
} from '../growth/ideas.js';

function resolveTargetChannel(req) {
  const channelId = req.body?.channel_id || req.headers?.['x-channel-id'] || req.query?.channel_id;
  if (channelId) {
    if (typeof channelId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(channelId)) return null;
    return getChannelById(channelId) || null;
  }
  return getActiveChannel(req);
}

function missingChannel(res) {
  return res.status(404).json({ error: 'Channel not found' });
}

// Missing age defaults to 7; any provided value must be a positive integer string (otherwise null -> 400)
function parseAgeDays(query = {}) {
  const raw = [query.age_days, query.ageDays, query.age].find((v) => v !== undefined);
  if (raw === undefined) return 7;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

export async function getGrowthReportHandler(req, res, { repoRoot, draftsDir, now } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';

    // Check if cohort comparison is requested (KAN-287)
    const cohortTag = req.query?.tag || req.query?.cohort || req.query?.style_tag || req.query?.style;
    const isCohortRequest = Boolean(
      cohortTag !== undefined ||
      req.query?.age_days !== undefined ||
      req.query?.ageDays !== undefined ||
      req.query?.type === 'cohort'
    );

    if (isCohortRequest) {
      const ageDays = parseAgeDays(req.query);
      if (ageDays === null) {
        return res.status(400).json({ error: 'age_days must be a positive integer' });
      }
      const report = await cohortReport(cohortTag || null, ageDays, {
        channelOrId: channel,
        repoRoot,
        draftsDir,
        now,
      });
      return res.json(report);
    }

    const existingReport = loadGrowthReport(effectiveId, repoRoot);
    if (existingReport) {
      return res.json(existingReport);
    }

    // Check if channel has scan data cached
    const cached = readCachedChannel(channel);
    if (!cached || !cached.videos || !Array.isArray(cached.videos) || cached.videos.length === 0) {
      return res.json({
        channel_id: effectiveId,
        channel_name: channel?.name || 'Channel',
        empty: true,
        reason: 'no_scan_data',
        message: 'No channel scan found. Run a channel scan first to populate performance data.',
      });
    }

    return res.json({
      channel_id: effectiveId,
      channel_name: channel?.name || 'Channel',
      empty: true,
      reason: 'not_generated',
      message: 'Growth report has not yet been generated for this channel. Click Refresh Report to generate.',
    });
  } catch (err) {
    console.error('getGrowthReportHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get growth report' });
  }
}

export async function refreshGrowthReportHandler(req, res) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const force = Boolean(req.body?.force);

    const report = await generateGrowthReport(channel, { force });
    return res.json(report);
  } catch (err) {
    console.error('refreshGrowthReportHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to refresh growth report' });
  }
}

export async function getGrowthStrategyHandler(req, res, { repoRoot } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';
    const strategy = loadChannelStrategy(effectiveId, repoRoot);

    if (!strategy) {
      return res.json({
        channel_id: effectiveId,
        channel_name: channel?.name || 'Channel',
        empty: true,
        strategy: null,
        message: 'No content strategy generated yet for this channel.',
      });
    }

    return res.json({
      channel_id: effectiveId,
      channel_name: channel?.name || 'Channel',
      strategy,
    });
  } catch (err) {
    console.error('getGrowthStrategyHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get channel strategy' });
  }
}

export async function updateGrowthStrategyHandler(req, res, { repoRoot } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';
    const { content_pillar, upload_cadence, positioning } = req.body || {};

    const updated = updateChannelStrategy(
      effectiveId,
      {
        content_pillar,
        upload_cadence,
        positioning,
      },
      repoRoot
    );

    return res.json({
      channel_id: effectiveId,
      strategy: updated,
    });
  } catch (err) {
    console.error('updateGrowthStrategyHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to update channel strategy' });
  }
}

export async function generateGrowthStrategyHandler(req, res, { repoRoot } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const force = req.body?.force !== undefined ? Boolean(req.body.force) : true;
    const strategy = await generateChannelStrategy(channel, { repoRoot, force });
    return res.json({
      channel_id: channel?.id || 'default',
      strategy,
    });
  } catch (err) {
    console.error('generateGrowthStrategyHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate growth strategy' });
  }
}

export async function getGrowthIdeasHandler(req, res, { repoRoot } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';
    const ideas = loadChannelIdeas(effectiveId, repoRoot);

    return res.json({
      channel_id: effectiveId,
      channel_name: channel?.name || 'Channel',
      ideas,
    });
  } catch (err) {
    console.error('getGrowthIdeasHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get growth ideas' });
  }
}

export async function generateGrowthIdeasHandler(req, res, { repoRoot } = {}) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const ideas = await generateGrowthIdeas(channel, { repoRoot, force: true });
    return res.json({
      channel_id: channel?.id || 'default',
      ideas,
    });
  } catch (err) {
    console.error('generateGrowthIdeasHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate growth ideas' });
  }
}

/**
 * Growth A/B target channel handlers (KAN-251).
 * Allows viewing candidate target channels, showing which account each is bound to,
 * what is missing if ineligible, and setting growth_ab_channel.
 */
export async function getGrowthABChannelHandler(req, res) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';
    const all = getAllChannels();
    const currentChannel = all.find((c) => c.id === effectiveId) || channel;
    const currentTargetId = currentChannel?.growth_ab_channel || effectiveId;

    const candidates = all.map((ch) => {
      const isCurrent = ch.id === effectiveId;
      const check = validateGrowthABChannel(effectiveId, ch.id, all);
      const sanitized = sanitizeChannel(ch);
      return {
        id: ch.id,
        name: ch.name,
        genre: ch.genre,
        is_current: isCurrent,
        has_api_key: sanitized.has_api_key,
        connected: sanitized.connected,
        bound_account: sanitized.bound_account,
        eligible: check.valid,
        missing: check.missing,
        reason: check.reason,
      };
    });

    return res.json({
      channel_id: effectiveId,
      channel_name: currentChannel?.name || effectiveId,
      growth_ab_channel: currentTargetId,
      default_channel: effectiveId,
      candidates,
    });
  } catch (err) {
    console.error('getGrowthABChannelHandler error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get growth A/B channel' });
  }
}

export async function setGrowthABChannelHandler(req, res) {
  try {
    const channel = resolveTargetChannel(req);
    if (!channel) return missingChannel(res);
    const effectiveId = channel?.id || 'default';
    const targetId = req.body?.growth_ab_channel || req.body?.target_channel_id;

    if (!targetId) {
      return res.status(400).json({ error: 'growth_ab_channel is required' });
    }

    const check = validateGrowthABChannel(effectiveId, targetId);
    if (!check.valid) {
      return res.status(400).json({ error: check.reason, missing: check.missing });
    }

    const updated = await updateChannel(effectiveId, { growth_ab_channel: check.target_channel_id });
    return res.json({
      success: true,
      channel_id: effectiveId,
      growth_ab_channel: check.target_channel_id,
      channel: sanitizeChannel(updated),
    });
  } catch (err) {
    console.error('setGrowthABChannelHandler error:', err);
    return res.status(400).json({ error: err.message || 'Failed to update growth A/B channel' });
  }
}

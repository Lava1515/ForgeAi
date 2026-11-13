import {
  getAllChannels,
  getChannelById,
  getActiveChannelId,
  setActiveChannelId,
  getActiveChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  sanitizeChannel,
} from './channelsManager.js';
import { researchChannelPsychologyRules } from './psychologyResearch.js';

export async function getChannelsHandler(req, res) {
  try {
    const channels = getAllChannels();
    const activeId = getActiveChannelId();
    const active = getActiveChannel(req);
    res.json({
      channels: channels.map(sanitizeChannel),
      active_channel_id: activeId,
      active_channel: sanitizeChannel(active),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getSingleChannelHandler(req, res) {
  try {
    const channel = getChannelById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.json(sanitizeChannel(channel));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createChannelHandler(req, res) {
  try {
    const channel = await createChannel(req.body);
    res.status(201).json(sanitizeChannel(channel));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function updateChannelHandler(req, res) {
  try {
    const updated = await updateChannel(req.params.id, req.body);
    res.json(sanitizeChannel(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function deleteChannelHandler(req, res) {
  try {
    const result = deleteChannel(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function switchChannelHandler(req, res) {
  try {
    const id = req.body?.channel_id;
    if (!id) return res.status(400).json({ error: 'channel_id is required' });
    setActiveChannelId(id);
    const active = getChannelById(id);
    res.json({ success: true, active_channel_id: id, channel: sanitizeChannel(active) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function researchRulesHandler(req, res) {
  try {
    const { genre, name, description } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre is required for psychology research' });
    const researched = await researchChannelPsychologyRules({ genre, name, description });
    res.json(researched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const websiteScraperService = require('../services/websiteScraper.service.js');

exports.fetchWebsiteData = async (req, res, next) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
      new URL(url); // basic validation
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const data = await websiteScraperService.fetchWebsiteData(url);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

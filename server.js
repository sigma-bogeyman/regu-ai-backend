import express from "express";
import cors from "cors";
import Parser from "rss-parser";

const app = express();
const parser = new Parser();

app.use(cors());
app.use(express.json());

// ==============================
// TEST ROUTE
// ==============================
app.get("/", (req, res) => {
  res.send("Backend is working ✅");
});

// ==============================
// AI ENGINE
// ==============================
app.post("/analyze", (req, res) => {

  const input = req.body.input;

  if (!input) {
    return res.status(400).json({
      result: "❌ No input received"
    });
  }

  const {
    product,
    dsdp,
    change,
    region,
    country,
    cqa,
    impurity,
    spec,
    sterility,
    process
  } = input;

  let classification = "Minor Variation";
  let filing = "Annual Reportable";
  let ctdImpact = [];
  let recommendation = "";

  if (
    cqa === "High" ||
    process === "Major" ||
    sterility === "Yes" ||
    spec === "Yes"
  ) {
    classification = "Major Variation";
    filing = "Prior Approval Supplement (PAS)";
  } else if (
    cqa === "Medium" ||
    impurity === "Yes"
  ) {
    classification = "Moderate Variation";
    filing = "CBE-30";
  }

  if (dsdp === "Drug Substance (DS)") {
    ctdImpact.push("3.2.S – Drug Substance");
  }

  if (dsdp === "Drug Product (DP)") {
    ctdImpact.push("3.2.P – Drug Product");
  }

  if (spec === "Yes") {
    ctdImpact.push("3.2.S.4 / 3.2.P.5 – Specifications");
  }

  if (process === "Major") {
    ctdImpact.push("3.2.S.2.2 / 3.2.P.3.3 – Manufacturing Process");
  }

  if (cqa === "High") {
    ctdImpact.push("Control Strategy / CQAs");
  }

  if (impurity === "Yes") {
    ctdImpact.push("3.2.S.3.2 / 3.2.P.5.5 – Impurity Profile");
  }

  if (sterility === "Yes") {
    ctdImpact.push("3.2.P.2.5 – Sterility");
  }

  if (ctdImpact.length === 0) {
    ctdImpact.push("No major CTD impact identified");
  }

  if (classification === "Major Variation") {
    recommendation =
      "Full comparability data required including analytical, functional and stability studies. Prior approval required before implementation.";
  } else if (classification === "Moderate Variation") {
    recommendation =
      "Submit under notification pathway (CBE-30 / Type IB). Provide risk justification.";
  } else {
    recommendation =
      "Can be included in annual report. Maintain internal documentation.";
  }

  const response = `
REGULATORY ASSESSMENT REPORT

Product Type: ${product}
Applies To: ${dsdp}
Change Type: ${change}
Region: ${region} (${country})

---------------------------------------

1. CLASSIFICATION:
${classification}

2. FILING STRATEGY:
${filing}

3. IMPACT:
- CQA: ${cqa}
- Impurity: ${impurity}
- Specification: ${spec}
- Sterility: ${sterility}
- Process: ${process}

4. CTD IMPACT:
${ctdImpact.join("\n")}

5. RECOMMENDATION:
${recommendation}

---------------------------------------
`;

  res.json({ result: response });
});

// ==============================
// NEWS API (FIXED)
// ==============================
app.get("/news", async (req, res) => {
  const news = [];

  try {
    // MHRA
    const mhra = await parser.parseURL(
      "https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency.atom"
    );

    mhra.items.slice(0, 5).forEach(item => {
      news.push({
        source: "MHRA",
        agency: "MHRA (UK)",
        title: item.title,
        date: item.pubDate,
        link: item.link
      });
    });

    // FDA
    const fda = await parser.parseURL(
      "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-announcements/rss.xml"
    );

    fda.items.slice(0, 5).forEach(item => {
      news.push({
        source: "FDA",
        agency: "FDA (USA)",
        title: item.title,
        date: item.pubDate,
        link: item.link
      });
    });

    // EMA
    const ema = await parser.parseURL(
      "https://www.ema.europa.eu/en/news-events/rss"
    );

    ema.items.slice(0, 5).forEach(item => {
      news.push({
        source: "EMA",
        agency: "EMA (EU)",
        title: item.title,
        date: item.pubDate,
        link: item.link
      });
    });

    // TGA
    const tga = await parser.parseURL(
      "https://www.tga.gov.au/news/rss.xml"
    );

    tga.items.slice(0, 3).forEach(item => {
      news.push({
        source: "TGA",
        agency: "TGA (Australia)",
        title: item.title,
        date: item.pubDate,
        link: item.link
      });
    });

    // Sort by latest
    news.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(news);

  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching news");
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(5001, "0.0.0.0", () => {
  console.log("✅ Server running on http://0.0.0.0:5001");
});
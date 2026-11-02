// Site-wide settings used by the build. Page-level settings live in each page's front matter.
export default {
    lang: "en",
    siteName: "Graduate Computer Science Society",
    shortName: "GCSS",
    baseURL: "https://umgcss.org", // no trailing slash
    description:
        "The Graduate Computer Science Society (GCSS) represents graduate students in the Department of Computer Science at the University of Manitoba.",
    // Default social share image (PNG/JPG, ideally 1200x630) under /contents/. Leave empty to omit og:image.
    image: "",
    logo: {
        light: "/contents/logo/gcss-mark-color.svg",
        dark: "/contents/logo/gcss-mark-reversed.svg",
    },
    favicon: "/contents/logo/gcss-mark-color.svg",
    themeColor: { light: "#f7f5f0", dark: "#121826" }, // browser UI color, matches the page background
    email: "pres@umgcss.org",
    parentOrganization: {
        name: "University of Manitoba",
        url: "https://umanitoba.ca",
    },
    // Footer icons, in this order. Supported: instagram, github, linkedin. Empty = hidden;
    // '#' = placeholder (shown, but the build warns until a real URL is set).
    social: {
        instagram: "#",
        github: "https://github.com/UofM-GCSS",
        linkedin: "#",
    },
    // Related links in the footer's bottom line. Page links are generated from app/ automatically.
    footerLinks: [
        {
            label: "Department of Computer Science",
            url: "https://umanitoba.ca/science/computer-science",
        },
        { label: "UMGPS", url: "https://www.umgps.org" },
    ],
};

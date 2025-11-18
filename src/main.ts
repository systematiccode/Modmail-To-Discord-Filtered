import { MessageData, ModMail } from "@devvit/protos";
import { Devvit, TriggerContext } from "@devvit/public-api";

const discordWebhookURLs = [
  "canary.discord.com",
  "ptb.discord.com",
  "discord.com",
  "canary.discordapp.com",
  "ptb.discordapp.com",
  "discordapp.com",
];

Devvit.configure({
  http: true,
  redditAPI: true,
});

Devvit.addSettings([
  {
    type: "string",
    name: "webhook",
    label: "Webhook URL (Discord or Slack)",
  },
  {
    type: "boolean",
    name: "outgoing",
    label:
      "Whether to send outgoing messages by mods to the webhook payload (Enabled by default, if disabled outgoing messages by mods will not be sent to the webhook payload.)",
    defaultValue: true,
  },
  {
    type: "string",
    name: "ignoreUsers",
    label: "Ignore list (comma-separated usernames, don't include u/)",
    helpText:
      "Add Reddit usernames (case-insensitive) separated by commas to skip them from webhook payloads (example: username1, username2, username3). This is totally optional.",
  },
  {
    type: "string",
    name: "rolePing",
    label: "Discord Role ID to Ping",
    helpText:
      "Enter a Discord Role ID to ping when a message is sent. Leave blank to disable. This is totally optional.",
  },
  {
    type: "boolean",
    name: "onlyModDiscussions",
    label: "Only Sync Mod Discussions",
    helpText:
      "If enabled, only mod discussion messages will be sent to the webhook. Messages from users will be ignored.",
    defaultValue: false,
  },
  {
    type: "string",
    name: "bodyRegex",
    label: "Body regex filter (optional)",
    helpText:
      "If set, only messages whose Markdown body matches this regex will be forwarded. Example: Body:\\s*Register Discord with Discord ID:\\s*([A-Za-z0-9._\\-#]+)",
  },
  {
    type: "string",
    name: "requiredSubject",
    label: "Required conversation subject (optional)",
    helpText:
      "If set, only conversations whose subject exactly matches this will be forwarded. Example: Discord Registration",
  },
  {
    type: "boolean",
    name: "blockBanned",
    label: "Block messages from banned users",
    helpText:
      "If enabled, messages from users banned in this subreddit will not be sent to the webhook.",
    defaultValue: false,
  },
  {
    type: "boolean",
    name: "includeBanStatus",
    label: "Include ban status in webhook message",
    helpText:
      "If enabled, the webhook message will include 'Status: Active' or 'Status: Banned'. If 'Block messages from banned users' is also enabled, banned messages are blocked but non-banned messages still include 'Status: Active'.",
    defaultValue: false,
  },
]);

Devvit.addTrigger({
  event: "ModMail",
  onEvent: async (event: ModMail, context: TriggerContext) => {
    try {
      if (!context) throw new Error("Context is probably undefined");
      await sendModMailToWebhook(event, context);
    } catch (error: any) {
      console.error("There was an error:", error.message);
    }
  },
});

function truncateDescription(
  description: string,
  maxLength: number = 4096
): string {
  if (description.length <= maxLength) {
    return description;
  }
  const truncationIndicator = "... (truncated)";
  return (
    description.substring(0, maxLength - truncationIndicator.length) +
    truncationIndicator
  );
}

async function sendModMailToWebhook(event: ModMail, context: TriggerContext) {
  try {
    const webhook = (await context.settings.get("webhook")) as string;
    const outgoing = (await context.settings.get("outgoing")) as boolean;
    const ignoreListRaw = (await context.settings.get("ignoreUsers")) as string;
    const rolePing = (await context.settings.get("rolePing")) as
      | string
      | undefined;
    const onlyModDiscussions = (await context.settings.get(
      "onlyModDiscussions"
    )) as boolean;
    const bodyRegexPattern = (await context.settings.get(
      "bodyRegex"
    )) as string;
    const requiredSubject = (await context.settings.get(
      "requiredSubject"
    )) as string;
    const blockBanned = (await context.settings.get(
      "blockBanned"
    )) as boolean;
    const includeBanStatus = (await context.settings.get(
      "includeBanStatus"
    )) as boolean;

    const ignoreList = (ignoreListRaw || "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean);

    if (!webhook) {
      console.error("No webhook URL provided");
      return;
    }

    const conversationId = event.conversationId ?? "";
    const actualConversationId = conversationId.replace(
      "ModmailConversation_",
      ""
    );
    const result = await context.reddit.modMail.getConversation({
      conversationId,
      markRead: false,
    });

    const subject = result.conversation?.subject ?? "";
    const isModDiscussion = result.conversation?.isInternal ?? false;

    if (onlyModDiscussions && !isModDiscussion) {
      console.log(
        "Skipping regular modmail because only mod discussions are enabled."
      );
      return;
    }

    // Optional subject filter
    if (requiredSubject && subject !== requiredSubject) {
      console.log(
        `Skipping conversation because subject "${subject}" != required "${requiredSubject}".`
      );
      return;
    }

    const modmailLink = `https://mod.reddit.com/mail/all/${actualConversationId}`;
    const messages = result.conversation?.messages ?? {};
    const messageIds = Object.keys(messages);
    const lastMessageId =
      messageIds.length > 0 ? messageIds[messageIds.length - 1] : undefined;
    const lastMessage: MessageData | undefined = lastMessageId
      ? messages[lastMessageId]
      : undefined;

    if (!lastMessage) {
      console.error("No messages found");
      return;
    }

    const authorName = lastMessage.author?.name ?? "Unknown";
    const body = lastMessage.bodyMarkdown ?? "";
    const participatingAs = lastMessage.participatingAs ?? "Unknown";
    const authorProfileLink = `https://www.reddit.com/u/${authorName}`;
    const isPrivateNote = lastMessage.isInternal ?? false;

    // --- Ban status logic ---
    let isBanned: boolean | null = null;
    let statusText: string | null = null;

    if ((blockBanned || includeBanStatus) && authorName !== "Unknown") {
      try {
        const subredditName = await context.reddit.getCurrentSubredditName();
        if (subredditName) {
          const bannedListing = await context.reddit.getBannedUsers({
            subredditName,
            username: authorName,
          });
          const bannedUsers = await bannedListing.all();
          isBanned = bannedUsers.some(
            (u) => u.name?.toLowerCase() === authorName.toLowerCase()
          );

          // If we are blocking banned users and they are banned → skip entirely
          if (blockBanned && isBanned) {
            console.log(
              `User "${authorName}" is banned in r/${subredditName}. Skipping webhook.`
            );
            return;
          }

          // If we want to include ban status, set "Active" or "Banned"
          if (includeBanStatus) {
            statusText = isBanned ? "Banned" : "Active";
          }
        }
      } catch (err: any) {
        console.error(
          `Error checking ban status for "${authorName}":`,
          err.message
        );
        // On error, we don't block or label; we just proceed without status.
      }
    }
    // --- end ban logic ---

    if (ignoreList.includes(authorName.toLowerCase())) {
      console.log(
        `User "${authorName}" is in the ignore list. Skipping webhook.`
      );
      return;
    }

    if (participatingAs === "moderator" && !outgoing) {
      console.log("Not sending outgoing messages to the webhook");
      return;
    }

    // Body regex filter (optional)
    if (bodyRegexPattern) {
      let regex: RegExp | null = null;
      try {
        // 'is' = ignore case + dot matches newline
        regex = new RegExp(bodyRegexPattern, "is");
      } catch (e: any) {
        console.error(
          `Invalid bodyRegex setting "${bodyRegexPattern}":`,
          (e as Error).message
        );
      }

      if (regex && !regex.test(body)) {
        console.log(
          `Body does not match bodyRegex "${bodyRegexPattern}". Skipping webhook.`
        );
        return;
      }
    }

    let payload: any;

    // Slack payload
    if (webhook.startsWith("https://hooks.slack.com/")) {
      const statusLine = statusText ? `\n*Status:* ${statusText}` : "";
      payload = {
        text: `*Modmail Subject:* <${modmailLink}|${subject}>\n*Author:* <${authorProfileLink}|${authorName}>\n*Body:* ${body}\n\n*Participant:* ${result.conversation?.participant?.name}${statusLine}\n*Participating As:* ${participatingAs}${
          isPrivateNote ? "\n*Note:* This is a private note." : ""
        }`,
      };
    }
    // Discord payload
    else if (
      discordWebhookURLs.some((url) =>
        webhook.startsWith(`https://${url}/api/webhooks/`)
      )
    ) {
      const statusLine = statusText ? `\nStatus: **${statusText}**` : "";
      const description =
        `Author: [**${authorName}**](${authorProfileLink})\n` +
        `Body: **${body}**\n\n` +
        `Participant: **${result.conversation?.participant?.name}**` +
        statusLine +
        `\nParticipating As: **${participatingAs}**`;

      payload = {
        content: rolePing ? `<@&${rolePing}>` : undefined,
        embeds: [
          {
            title: subject,
            url: modmailLink,
            author: {
              name: authorName,
              url: authorProfileLink,
            },
            description: truncateDescription(description),
            color: isPrivateNote ? 0x00cc66 : 0x3498db, // private note vs regular
            footer: isPrivateNote
              ? { text: "📌 Private Moderator Note" }
              : undefined,
          },
        ],
      };
    } else {
      throw new Error("This webhook is neither from Slack nor Discord.");
    }

    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("Error sending data to webhook");
    }
  } catch (error: any) {
    console.error("Error:", error.message);
  }
}

export default Devvit;

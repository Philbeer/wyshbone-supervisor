// Referenced from blueprint:javascript_database
import { 
  users, 
  suggestedLeads, 
  userSignals,
  processedSignals,
  type User, 
  type InsertUser, 
  type SuggestedLead, 
  type UserSignal,
  type InsertSuggestedLead,
  type InsertUserSignal 
} from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getSuggestedLeads(userId: string): Promise<SuggestedLead[]>;
  getRecentSignals(userId: string): Promise<UserSignal[]>;
  createSuggestedLead(lead: InsertSuggestedLead): Promise<SuggestedLead>;
  createSignal(signal: InsertUserSignal): Promise<UserSignal>;
  isSignalProcessed(signalId: string, source: string): Promise<boolean>;
  markSignalProcessed(signalId: string, source: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getSuggestedLeads(userId: string): Promise<SuggestedLead[]> {
    const leads = await db
      .select()
      .from(suggestedLeads)
      .where(eq(suggestedLeads.userId, userId))
      .orderBy(desc(suggestedLeads.score));
    return leads;
  }

  async getRecentSignals(userId: string): Promise<UserSignal[]> {
    const signals = await db
      .select()
      .from(userSignals)
      .where(eq(userSignals.userId, userId))
      .orderBy(desc(userSignals.createdAt))
      .limit(20);
    return signals;
  }

  async createSuggestedLead(lead: InsertSuggestedLead): Promise<SuggestedLead> {
    const [newLead] = await db
      .insert(suggestedLeads)
      .values(lead)
      .returning();
    return newLead;
  }

  async createSignal(signal: InsertUserSignal): Promise<UserSignal> {
    const [newSignal] = await db
      .insert(userSignals)
      .values(signal)
      .returning();
    return newSignal;
  }

  async isSignalProcessed(signalId: string, source: string): Promise<boolean> {
    const [record] = await db
      .select()
      .from(processedSignals)
      .where(eq(processedSignals.signalId, `${source}:${signalId}`))
      .limit(1);
    return !!record;
  }

  async markSignalProcessed(signalId: string, source: string): Promise<void> {
    await db
      .insert(processedSignals)
      .values({
        signalId: `${source}:${signalId}`,
        signalSource: source
      });
  }
}

export const storage = new DatabaseStorage();

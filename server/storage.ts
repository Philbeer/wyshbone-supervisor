// Referenced from blueprint:javascript_database
import { 
  users, 
  suggestedLeads, 
  userSignals,
  type User, 
  type InsertUser, 
  type SuggestedLead, 
  type UserSignal,
  type InsertSuggestedLead 
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
  createSignal(signal: { userId: string; type: string; payload: any }): Promise<UserSignal>;
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

  async createSignal(signal: { userId: string; type: string; payload: any }): Promise<UserSignal> {
    const [newSignal] = await db
      .insert(userSignals)
      .values(signal)
      .returning();
    return newSignal;
  }
}

export const storage = new DatabaseStorage();

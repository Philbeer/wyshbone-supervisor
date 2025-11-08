import { type User, type InsertUser, type SuggestedLead, type UserSignal } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getSuggestedLeads(userId: string): Promise<SuggestedLead[]>;
  getRecentSignals(userId: string): Promise<UserSignal[]>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private suggestedLeads: SuggestedLead[];
  private userSignals: UserSignal[];

  constructor() {
    this.users = new Map();
    this.suggestedLeads = [];
    this.userSignals = [];
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getSuggestedLeads(userId: string): Promise<SuggestedLead[]> {
    return this.suggestedLeads
      .filter(lead => lead.userId === userId)
      .sort((a, b) => b.score - a.score);
  }

  async getRecentSignals(userId: string): Promise<UserSignal[]> {
    return this.userSignals
      .filter(signal => signal.userId === userId)
      .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
      .slice(0, 20);
  }
}

export const storage = new MemStorage();

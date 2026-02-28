/**
 * Create a Supabase browser client.
 * Works in all three platforms (xfor, antfarm, agentpuzzles).
 *
 * Usage:
 *   import { createBrowserSupabase } from '@thinkoff/core/supabase';
 *   const supabase = createBrowserSupabase();
 *
 * For typed clients, pass your Database generic:
 *   const supabase = createBrowserSupabase<Database>();
 */
export declare function createBrowserSupabase<T = unknown>(): import("@supabase/supabase-js").SupabaseClient<T, "public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">, ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) extends infer T_1 ? T_1 extends ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) ? T_1 extends string & Exclude<keyof T, "__InternalSupabase"> ? T_1 : "public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<Exclude<keyof T, "__InternalSupabase">, "__InternalSupabase"> : never : never, Omit<T, "__InternalSupabase">[("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) extends infer T_2 ? T_2 extends ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) ? T_2 extends string & Exclude<keyof T, "__InternalSupabase"> ? T_2 : "public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<Exclude<keyof T, "__InternalSupabase">, "__InternalSupabase"> : never : never] extends {
    Tables: Record<string, {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: {
            foreignKeyName: string;
            columns: string[];
            isOneToOne?: boolean;
            referencedRelation: string;
            referencedColumns: string[];
        }[];
    }>;
    Views: Record<string, {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: {
            foreignKeyName: string;
            columns: string[];
            isOneToOne?: boolean;
            referencedRelation: string;
            referencedColumns: string[];
        }[];
    } | {
        Row: Record<string, unknown>;
        Relationships: {
            foreignKeyName: string;
            columns: string[];
            isOneToOne?: boolean;
            referencedRelation: string;
            referencedColumns: string[];
        }[];
    }>;
    Functions: Record<string, {
        Args: Record<string, unknown> | never;
        Returns: unknown;
        SetofOptions?: {
            isSetofReturn?: boolean | undefined;
            isOneToOne?: boolean | undefined;
            isNotNullable?: boolean | undefined;
            to: string;
            from: string;
        };
    }>;
} ? Omit<T, "__InternalSupabase">[("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) extends infer T_3 ? T_3 extends ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) ? T_3 extends string & Exclude<keyof T, "__InternalSupabase"> ? T_3 : "public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<Exclude<keyof T, "__InternalSupabase">, "__InternalSupabase"> : never : never] : never, ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) extends infer T_4 ? T_4 extends ("public" extends Exclude<keyof T, "__InternalSupabase"> ? Exclude<keyof T, "__InternalSupabase"> & "public" : string & Exclude<keyof T, "__InternalSupabase">) ? T_4 extends string & Exclude<keyof T, "__InternalSupabase"> ? T extends {
    __InternalSupabase: {
        PostgrestVersion: string;
    };
} ? T["__InternalSupabase"] : {
    PostgrestVersion: "12";
} : T_4 extends {
    PostgrestVersion: string;
} ? T_4 : never : never : never>;

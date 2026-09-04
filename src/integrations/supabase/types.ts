export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      agent_limits: {
        Row: {
          agent_id: string;
          auto_disable_on_limit: boolean;
          created_at: string;
          id: string;
          max_spend_per_day_usd: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          auto_disable_on_limit?: boolean;
          created_at?: string;
          id?: string;
          max_spend_per_day_usd?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          auto_disable_on_limit?: boolean;
          created_at?: string;
          id?: string;
          max_spend_per_day_usd?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      agent_memory_config: {
        Row: {
          agent_id: string;
          chat_retention_days: number;
          created_at: string;
          ltm_auto_extract: boolean;
          ltm_enabled: boolean;
          ltm_max_items: number;
          ltm_recall_top_k: number;
          stm_enabled: boolean;
          stm_summarize: boolean;
          stm_summary_model: string | null;
          stm_window_messages: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          chat_retention_days?: number;
          created_at?: string;
          ltm_auto_extract?: boolean;
          ltm_enabled?: boolean;
          ltm_max_items?: number;
          ltm_recall_top_k?: number;
          stm_enabled?: boolean;
          stm_summarize?: boolean;
          stm_summary_model?: string | null;
          stm_window_messages?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          chat_retention_days?: number;
          created_at?: string;
          ltm_auto_extract?: boolean;
          ltm_enabled?: boolean;
          ltm_max_items?: number;
          ltm_recall_top_k?: number;
          stm_enabled?: boolean;
          stm_summarize?: boolean;
          stm_summary_model?: string | null;
          stm_window_messages?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      agent_memory_items: {
        Row: {
          agent_id: string;
          content: string;
          conversation_id: string | null;
          created_at: string;
          expires_at: string | null;
          id: string;
          keywords: string[];
          kind: string;
          last_used_at: string | null;
          score: number;
          usage_count: number;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          content: string;
          conversation_id?: string | null;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          keywords?: string[];
          kind?: string;
          last_used_at?: string | null;
          score?: number;
          usage_count?: number;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          content?: string;
          conversation_id?: string | null;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          keywords?: string[];
          kind?: string;
          last_used_at?: string | null;
          score?: number;
          usage_count?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      agent_skills: {
        Row: {
          body: string;
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          tags: string[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          body?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          tags?: string[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          tags?: string[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      agent_versions: {
        Row: {
          agent_id: string;
          config: Json;
          created_at: string;
          id: string;
          kind: string;
          label: string;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          config?: Json;
          created_at?: string;
          id?: string;
          kind?: string;
          label?: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          config?: Json;
          created_at?: string;
          id?: string;
          kind?: string;
          label?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_versions_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
        ];
      };
      agents: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          knowledge_base_id: string | null;
          llm_model: string;
          llm_provider: string;
          max_tokens: number;
          n8n_webhook_url: string | null;
          name: string;
          system_prompt: string | null;
          temperature: number;
          tools: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          knowledge_base_id?: string | null;
          llm_model?: string;
          llm_provider?: string;
          max_tokens?: number;
          n8n_webhook_url?: string | null;
          name: string;
          system_prompt?: string | null;
          temperature?: number;
          tools?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          knowledge_base_id?: string | null;
          llm_model?: string;
          llm_provider?: string;
          max_tokens?: number;
          n8n_webhook_url?: string | null;
          name?: string;
          system_prompt?: string | null;
          temperature?: number;
          tools?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agents_knowledge_base_fk";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_analyst_schedules: {
        Row: {
          at_hour: number;
          cadence: string;
          created_at: string;
          email_report: boolean;
          enabled: boolean;
          id: string;
          last_error: string | null;
          last_run_at: string | null;
          last_status: string | null;
          next_run_at: string;
          thread_id: string;
          user_id: string;
          weekday: number;
        };
        Insert: {
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          email_report?: boolean;
          enabled?: boolean;
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          last_status?: string | null;
          next_run_at?: string;
          thread_id: string;
          user_id: string;
          weekday?: number;
        };
        Update: {
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          email_report?: boolean;
          enabled?: boolean;
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          last_status?: string | null;
          next_run_at?: string;
          thread_id?: string;
          user_id?: string;
          weekday?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ai_analyst_schedules_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: true;
            referencedRelation: "ai_analyst_threads";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_analyst_threads: {
        Row: {
          analyst_id: string;
          created_at: string;
          id: string;
          title: string;
          turns: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          analyst_id: string;
          created_at?: string;
          id?: string;
          title?: string;
          turns?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          analyst_id?: string;
          created_at?: string;
          id?: string;
          title?: string;
          turns?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_analyst_threads_analyst_id_fkey";
            columns: ["analyst_id"];
            isOneToOne: false;
            referencedRelation: "ai_analysts";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_analysts: {
        Row: {
          created_at: string;
          id: string;
          model: string;
          name: string;
          source: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          model: string;
          name: string;
          source: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          model?: string;
          name?: string;
          source?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      approvals: {
        Row: {
          action_title: string;
          action_type: string;
          agent_avatar: string | null;
          agent_id: string | null;
          agent_name: string;
          approver_group_ids: string[];
          approver_user_ids: string[];
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          description: string | null;
          id: string;
          notified_at: string | null;
          payload: Json;
          risk_level: string;
          status: string;
          swarm_run_id: string | null;
          user_id: string;
        };
        Insert: {
          action_title: string;
          action_type: string;
          agent_avatar?: string | null;
          agent_id?: string | null;
          agent_name: string;
          approver_group_ids?: string[];
          approver_user_ids?: string[];
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          description?: string | null;
          id?: string;
          notified_at?: string | null;
          payload?: Json;
          risk_level?: string;
          status?: string;
          swarm_run_id?: string | null;
          user_id: string;
        };
        Update: {
          action_title?: string;
          action_type?: string;
          agent_avatar?: string | null;
          agent_id?: string | null;
          agent_name?: string;
          approver_group_ids?: string[];
          approver_user_ids?: string[];
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          description?: string | null;
          id?: string;
          notified_at?: string | null;
          payload?: Json;
          risk_level?: string;
          status?: string;
          swarm_run_id?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      audit_client_actions: {
        Row: {
          action: string;
        };
        Insert: {
          action: string;
        };
        Update: {
          action?: string;
        };
        Relationships: [];
      };
      audit_events: {
        Row: {
          action: string;
          actor_email: string | null;
          chain_hash: string | null;
          chain_seq: number | null;
          created_at: string;
          decision_id: string | null;
          detail: Json;
          id: string;
          resource_id: string | null;
          resource_name: string | null;
          resource_type: string | null;
          user_id: string | null;
        };
        Insert: {
          action: string;
          actor_email?: string | null;
          chain_hash?: string | null;
          chain_seq?: number | null;
          created_at?: string;
          decision_id?: string | null;
          detail?: Json;
          id?: string;
          resource_id?: string | null;
          resource_name?: string | null;
          resource_type?: string | null;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          actor_email?: string | null;
          chain_hash?: string | null;
          chain_seq?: number | null;
          created_at?: string;
          decision_id?: string | null;
          detail?: Json;
          id?: string;
          resource_id?: string | null;
          resource_name?: string | null;
          resource_type?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      bi_alerts: {
        Row: {
          aggregation: string;
          basis: string;
          column_name: string;
          created_at: string;
          dashboard_id: string;
          email_enabled: boolean;
          horizon: number | null;
          id: string;
          is_active: boolean;
          label: string;
          last_checked_at: string | null;
          last_state: string;
          last_value: number | null;
          operator: string;
          threshold: number;
          user_id: string;
          widget_id: string;
        };
        Insert: {
          aggregation?: string;
          basis?: string;
          column_name?: string;
          created_at?: string;
          dashboard_id: string;
          email_enabled?: boolean;
          horizon?: number | null;
          id?: string;
          is_active?: boolean;
          label?: string;
          last_checked_at?: string | null;
          last_state?: string;
          last_value?: number | null;
          operator: string;
          threshold?: number;
          user_id: string;
          widget_id: string;
        };
        Update: {
          aggregation?: string;
          basis?: string;
          column_name?: string;
          created_at?: string;
          dashboard_id?: string;
          email_enabled?: boolean;
          horizon?: number | null;
          id?: string;
          is_active?: boolean;
          label?: string;
          last_checked_at?: string | null;
          last_state?: string;
          last_value?: number | null;
          operator?: string;
          threshold?: number;
          user_id?: string;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bi_alerts_dashboard_id_fkey";
            columns: ["dashboard_id"];
            isOneToOne: false;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_dashboard_versions: {
        Row: {
          created_at: string;
          dashboard_id: string;
          filters: Json;
          id: string;
          label: string | null;
          layout: Json;
          name: string;
          pages: Json;
          theme: Json;
          user_id: string;
          widgets: Json;
        };
        Insert: {
          created_at?: string;
          dashboard_id: string;
          filters?: Json;
          id?: string;
          label?: string | null;
          layout: Json;
          name: string;
          pages?: Json;
          theme?: Json;
          user_id: string;
          widgets: Json;
        };
        Update: {
          created_at?: string;
          dashboard_id?: string;
          filters?: Json;
          id?: string;
          label?: string | null;
          layout?: Json;
          name?: string;
          pages?: Json;
          theme?: Json;
          user_id?: string;
          widgets?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "bi_dashboard_versions_dashboard_id_fkey";
            columns: ["dashboard_id"];
            isOneToOne: false;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_dashboards: {
        Row: {
          ai_model: string | null;
          created_at: string;
          description: string | null;
          filters: Json;
          folder_id: string | null;
          id: string;
          last_viewed_at: string | null;
          layout: Json;
          name: string;
          pages: Json;
          public_slug: string | null;
          published: boolean;
          published_at: string | null;
          theme: Json;
          updated_at: string;
          user_id: string;
          version: number;
          view_count: number;
          widgets: Json;
          workspace_id: string | null;
        };
        Insert: {
          ai_model?: string | null;
          created_at?: string;
          description?: string | null;
          filters?: Json;
          folder_id?: string | null;
          id?: string;
          last_viewed_at?: string | null;
          layout?: Json;
          name: string;
          pages?: Json;
          public_slug?: string | null;
          published?: boolean;
          published_at?: string | null;
          theme?: Json;
          updated_at?: string;
          user_id: string;
          version?: number;
          view_count?: number;
          widgets?: Json;
          workspace_id?: string | null;
        };
        Update: {
          ai_model?: string | null;
          created_at?: string;
          description?: string | null;
          filters?: Json;
          folder_id?: string | null;
          id?: string;
          last_viewed_at?: string | null;
          layout?: Json;
          name?: string;
          pages?: Json;
          public_slug?: string | null;
          published?: boolean;
          published_at?: string | null;
          theme?: Json;
          updated_at?: string;
          user_id?: string;
          version?: number;
          view_count?: number;
          widgets?: Json;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "bi_dashboards_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "bi_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bi_dashboards_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "bi_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_folders: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          parent_id: string | null;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          parent_id?: string | null;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          parent_id?: string | null;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "bi_folders_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "bi_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bi_folders_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "bi_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_promotions: {
        Row: {
          created_at: string;
          id: string;
          note: string | null;
          promoted_by: string;
          source_dashboard_id: string;
          target_dashboard_id: string;
          target_workspace_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          note?: string | null;
          promoted_by: string;
          source_dashboard_id: string;
          target_dashboard_id: string;
          target_workspace_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          note?: string | null;
          promoted_by?: string;
          source_dashboard_id?: string;
          target_dashboard_id?: string;
          target_workspace_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bi_promotions_source_dashboard_id_fkey";
            columns: ["source_dashboard_id"];
            isOneToOne: false;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bi_promotions_target_dashboard_id_fkey";
            columns: ["target_dashboard_id"];
            isOneToOne: false;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bi_promotions_target_workspace_id_fkey";
            columns: ["target_workspace_id"];
            isOneToOne: false;
            referencedRelation: "bi_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_sample_dashboards: {
        Row: {
          description: string | null;
          filters: Json;
          id: string;
          layout: Json;
          name: string;
          pages: Json;
          sort: number;
          theme: Json;
          widgets: Json;
        };
        Insert: {
          description?: string | null;
          filters?: Json;
          id?: string;
          layout: Json;
          name: string;
          pages?: Json;
          sort: number;
          theme?: Json;
          widgets: Json;
        };
        Update: {
          description?: string | null;
          filters?: Json;
          id?: string;
          layout?: Json;
          name?: string;
          pages?: Json;
          sort?: number;
          theme?: Json;
          widgets?: Json;
        };
        Relationships: [];
      };
      bi_schedules: {
        Row: {
          at_hour: number;
          cadence: string;
          created_at: string;
          dashboard_id: string;
          email_report: boolean;
          enabled: boolean;
          id: string;
          last_error: string | null;
          last_run_at: string | null;
          last_status: string | null;
          next_run_at: string;
          user_id: string;
          weekday: number;
        };
        Insert: {
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          dashboard_id: string;
          email_report?: boolean;
          enabled?: boolean;
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          last_status?: string | null;
          next_run_at?: string;
          user_id: string;
          weekday?: number;
        };
        Update: {
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          dashboard_id?: string;
          email_report?: boolean;
          enabled?: boolean;
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          last_status?: string | null;
          next_run_at?: string;
          user_id?: string;
          weekday?: number;
        };
        Relationships: [
          {
            foreignKeyName: "bi_schedules_dashboard_id_fkey";
            columns: ["dashboard_id"];
            isOneToOne: true;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_widget_results: {
        Row: {
          columns: Json;
          dashboard_id: string;
          refreshed_at: string;
          rows: Json;
          truncated: boolean;
          user_id: string;
          widget_id: string;
        };
        Insert: {
          columns?: Json;
          dashboard_id: string;
          refreshed_at?: string;
          rows?: Json;
          truncated?: boolean;
          user_id: string;
          widget_id: string;
        };
        Update: {
          columns?: Json;
          dashboard_id?: string;
          refreshed_at?: string;
          rows?: Json;
          truncated?: boolean;
          user_id?: string;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bi_widget_results_dashboard_id_fkey";
            columns: ["dashboard_id"];
            isOneToOne: false;
            referencedRelation: "bi_dashboards";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_workspace_members: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          principal_id: string;
          principal_type: string;
          role: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id: string;
          principal_type: string;
          role?: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id?: string;
          principal_type?: string;
          role?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bi_workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "bi_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      bi_workspaces: {
        Row: {
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      budget_limits: {
        Row: {
          alert_thresholds: number[];
          alerts_enabled: boolean;
          cap_exceeded_notified_period: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_active: boolean;
          monthly_cap_usd: number;
          notified_period: string | null;
          notified_thresholds: number[];
          scope_id: string;
          scope_type: string;
          updated_at: string;
        };
        Insert: {
          alert_thresholds?: number[];
          alerts_enabled?: boolean;
          cap_exceeded_notified_period?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          monthly_cap_usd: number;
          notified_period?: string | null;
          notified_thresholds?: number[];
          scope_id: string;
          scope_type: string;
          updated_at?: string;
        };
        Update: {
          alert_thresholds?: number[];
          alerts_enabled?: boolean;
          cap_exceeded_notified_period?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          monthly_cap_usd?: number;
          notified_period?: string | null;
          notified_thresholds?: number[];
          scope_id?: string;
          scope_type?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      budget_settings: {
        Row: {
          alert_thresholds: number[];
          alerts_enabled: boolean;
          cap_exceeded_notified_period: string | null;
          created_at: string;
          id: string;
          monthly_cap_usd: number;
          notified_period: string | null;
          notified_thresholds: number[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alert_thresholds?: number[];
          alerts_enabled?: boolean;
          cap_exceeded_notified_period?: string | null;
          created_at?: string;
          id?: string;
          monthly_cap_usd?: number;
          notified_period?: string | null;
          notified_thresholds?: number[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alert_thresholds?: number[];
          alerts_enabled?: boolean;
          cap_exceeded_notified_period?: string | null;
          created_at?: string;
          id?: string;
          monthly_cap_usd?: number;
          notified_period?: string | null;
          notified_thresholds?: number[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      catalog_assets: {
        Row: {
          asset_type: string;
          columns: Json;
          created_at: string;
          description: string | null;
          file_count: number | null;
          format: string | null;
          fqn: string;
          id: string;
          last_crawled_at: string;
          name: string;
          owner: string | null;
          pii: boolean;
          row_count: number | null;
          schema_hash: string | null;
          schema_name: string | null;
          size_bytes: number | null;
          source_id: string;
          status: string;
          tags: string[];
          user_id: string;
        };
        Insert: {
          asset_type: string;
          columns?: Json;
          created_at?: string;
          description?: string | null;
          file_count?: number | null;
          format?: string | null;
          fqn: string;
          id?: string;
          last_crawled_at?: string;
          name: string;
          owner?: string | null;
          pii?: boolean;
          row_count?: number | null;
          schema_hash?: string | null;
          schema_name?: string | null;
          size_bytes?: number | null;
          source_id: string;
          status?: string;
          tags?: string[];
          user_id: string;
        };
        Update: {
          asset_type?: string;
          columns?: Json;
          created_at?: string;
          description?: string | null;
          file_count?: number | null;
          format?: string | null;
          fqn?: string;
          id?: string;
          last_crawled_at?: string;
          name?: string;
          owner?: string | null;
          pii?: boolean;
          row_count?: number | null;
          schema_hash?: string | null;
          schema_name?: string | null;
          size_bytes?: number | null;
          source_id?: string;
          status?: string;
          tags?: string[];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "catalog_assets_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "catalog_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      catalog_glossary_terms: {
        Row: {
          created_at: string;
          definition: string;
          id: string;
          term: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          definition?: string;
          id?: string;
          term: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          definition?: string;
          id?: string;
          term?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      catalog_lineage: {
        Row: {
          created_at: string;
          downstream_column: string | null;
          downstream_fqn: string;
          id: string;
          pipeline_id: string | null;
          source_id: string;
          source_system: string;
          upstream_column: string | null;
          upstream_fqn: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          downstream_column?: string | null;
          downstream_fqn: string;
          id?: string;
          pipeline_id?: string | null;
          source_id: string;
          source_system?: string;
          upstream_column?: string | null;
          upstream_fqn: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          downstream_column?: string | null;
          downstream_fqn?: string;
          id?: string;
          pipeline_id?: string | null;
          source_id?: string;
          source_system?: string;
          upstream_column?: string | null;
          upstream_fqn?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "catalog_lineage_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalog_lineage_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "catalog_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      catalog_sources: {
        Row: {
          config: Json;
          connection_id: string | null;
          crawl_schedule: string;
          crawl_stats: Json;
          created_at: string;
          credentials: Json | null;
          id: string;
          kind: string;
          last_crawl_at: string | null;
          last_error: string | null;
          name: string;
          next_crawl_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          connection_id?: string | null;
          crawl_schedule?: string;
          crawl_stats?: Json;
          created_at?: string;
          credentials?: Json | null;
          id?: string;
          kind: string;
          last_crawl_at?: string | null;
          last_error?: string | null;
          name: string;
          next_crawl_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          connection_id?: string | null;
          crawl_schedule?: string;
          crawl_stats?: Json;
          created_at?: string;
          credentials?: Json | null;
          id?: string;
          kind?: string;
          last_crawl_at?: string | null;
          last_error?: string | null;
          name?: string;
          next_crawl_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "catalog_sources_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "data_warehouse_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      concurrency_leases: {
        Row: {
          acquired_at: string;
          bucket: string;
          expires_at: string;
          id: string;
        };
        Insert: {
          acquired_at?: string;
          bucket: string;
          expires_at: string;
          id?: string;
        };
        Update: {
          acquired_at?: string;
          bucket?: string;
          expires_at?: string;
          id?: string;
        };
        Relationships: [];
      };
      contact_messages: {
        Row: {
          admin_notes: string | null;
          created_at: string;
          email: string;
          id: string;
          message: string;
          name: string;
          source_page: string | null;
          status: string;
          subject: string | null;
          updated_at: string;
          user_agent: string | null;
        };
        Insert: {
          admin_notes?: string | null;
          created_at?: string;
          email: string;
          id?: string;
          message: string;
          name: string;
          source_page?: string | null;
          status?: string;
          subject?: string | null;
          updated_at?: string;
          user_agent?: string | null;
        };
        Update: {
          admin_notes?: string | null;
          created_at?: string;
          email?: string;
          id?: string;
          message?: string;
          name?: string;
          source_page?: string | null;
          status?: string;
          subject?: string | null;
          updated_at?: string;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      conversation_memory: {
        Row: {
          conversation_id: string;
          created_at: string;
          last_summarized_message_id: string | null;
          scratchpad: Json;
          summary: string | null;
          summary_token_estimate: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          last_summarized_message_id?: string | null;
          scratchpad?: Json;
          summary?: string | null;
          summary_token_estimate?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          last_summarized_message_id?: string | null;
          scratchpad?: Json;
          summary?: string | null;
          summary_token_estimate?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          agent_id: string;
          created_at: string;
          id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
        ];
      };
      cron_locks: {
        Row: {
          holder: string | null;
          locked_until: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          holder?: string | null;
          locked_until?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          holder?: string | null;
          locked_until?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      data_quality_results: {
        Row: {
          detail: string | null;
          failing_rows: number;
          id: string;
          ran_at: string;
          status: string;
          table_id: string;
          test_id: string;
          total_rows: number;
          user_id: string;
        };
        Insert: {
          detail?: string | null;
          failing_rows?: number;
          id?: string;
          ran_at?: string;
          status: string;
          table_id: string;
          test_id: string;
          total_rows?: number;
          user_id: string;
        };
        Update: {
          detail?: string | null;
          failing_rows?: number;
          id?: string;
          ran_at?: string;
          status?: string;
          table_id?: string;
          test_id?: string;
          total_rows?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "data_quality_results_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_quality_results_test_id_fkey";
            columns: ["test_id"];
            isOneToOne: false;
            referencedRelation: "data_quality_tests";
            referencedColumns: ["id"];
          },
        ];
      };
      data_quality_tests: {
        Row: {
          column_name: string | null;
          config: Json;
          created_at: string;
          enabled: boolean;
          id: string;
          kind: string;
          severity: string;
          table_id: string;
          user_id: string;
        };
        Insert: {
          column_name?: string | null;
          config?: Json;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          kind: string;
          severity?: string;
          table_id: string;
          user_id: string;
        };
        Update: {
          column_name?: string | null;
          config?: Json;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          kind?: string;
          severity?: string;
          table_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "data_quality_tests_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      data_warehouse_connections: {
        Row: {
          created_at: string;
          credentials: Json;
          credentials_rotated_at: string | null;
          id: string;
          is_active: boolean;
          last_test_error: string | null;
          last_test_status: string | null;
          last_tested_at: string | null;
          name: string;
          provider: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          credentials?: Json;
          credentials_rotated_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          name: string;
          provider: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          credentials?: Json;
          credentials_rotated_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          name?: string;
          provider?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      decisions: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          lakehouse_snapshot_id: string | null;
          root_ref: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          kind: string;
          lakehouse_snapshot_id?: string | null;
          root_ref?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          lakehouse_snapshot_id?: string | null;
          root_ref?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      email_send_log: {
        Row: {
          created_at: string;
          error_message: string | null;
          id: string;
          message_id: string | null;
          metadata: Json | null;
          recipient_email: string;
          status: string;
          template_name: string;
        };
        Insert: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          message_id?: string | null;
          metadata?: Json | null;
          recipient_email: string;
          status: string;
          template_name: string;
        };
        Update: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          message_id?: string | null;
          metadata?: Json | null;
          recipient_email?: string;
          status?: string;
          template_name?: string;
        };
        Relationships: [];
      };
      email_unsubscribe_tokens: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          token: string;
          used_at: string | null;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          token: string;
          used_at?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          token?: string;
          used_at?: string | null;
        };
        Relationships: [];
      };
      embed_keys: {
        Row: {
          allow_ai: boolean;
          allowed_domains: string[];
          created_at: string;
          expires_at: string | null;
          id: string;
          is_active: boolean;
          key: string;
          last_used_at: string | null;
          last_used_ip: string | null;
          name: string;
          require_signed_viewer: boolean;
          resource_id: string;
          resource_type: string;
          revoked_at: string | null;
          rotated_from: string | null;
          transcript_retention_days: number;
          updated_at: string;
          use_count: number;
          user_id: string;
          viewer_attributes: string[];
          viewer_secret: Json | null;
        };
        Insert: {
          allow_ai?: boolean;
          allowed_domains?: string[];
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name: string;
          require_signed_viewer?: boolean;
          resource_id: string;
          resource_type: string;
          revoked_at?: string | null;
          rotated_from?: string | null;
          transcript_retention_days?: number;
          updated_at?: string;
          use_count?: number;
          user_id: string;
          viewer_attributes?: string[];
          viewer_secret?: Json | null;
        };
        Update: {
          allow_ai?: boolean;
          allowed_domains?: string[];
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key?: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name?: string;
          require_signed_viewer?: boolean;
          resource_id?: string;
          resource_type?: string;
          revoked_at?: string | null;
          rotated_from?: string | null;
          transcript_retention_days?: number;
          updated_at?: string;
          use_count?: number;
          user_id?: string;
          viewer_attributes?: string[];
          viewer_secret?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "embed_keys_rotated_from_fkey";
            columns: ["rotated_from"];
            isOneToOne: false;
            referencedRelation: "embed_keys";
            referencedColumns: ["id"];
          },
        ];
      };
      etl_ingest_events: {
        Row: {
          id: number;
          payload: Json;
          pipeline_id: string;
          received_at: string;
          user_id: string;
        };
        Insert: {
          id?: number;
          payload: Json;
          pipeline_id: string;
          received_at?: string;
          user_id: string;
        };
        Update: {
          id?: number;
          payload?: Json;
          pipeline_id?: string;
          received_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "etl_ingest_events_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      etl_pipeline_state: {
        Row: {
          cursor_value: string | null;
          node_id: string;
          pipeline_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cursor_value?: string | null;
          node_id: string;
          pipeline_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cursor_value?: string | null;
          node_id?: string;
          pipeline_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "etl_pipeline_state_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      etl_pipeline_versions: {
        Row: {
          created_at: string;
          graph: Json | null;
          id: string;
          mode: string;
          name: string;
          pipeline_id: string;
          requirements: string;
          source_code: string;
          user_id: string;
          version_no: number;
        };
        Insert: {
          created_at?: string;
          graph?: Json | null;
          id?: string;
          mode: string;
          name: string;
          pipeline_id: string;
          requirements?: string;
          source_code?: string;
          user_id: string;
          version_no: number;
        };
        Update: {
          created_at?: string;
          graph?: Json | null;
          id?: string;
          mode?: string;
          name?: string;
          pipeline_id?: string;
          requirements?: string;
          source_code?: string;
          user_id?: string;
          version_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: "etl_pipeline_versions_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      etl_pipelines: {
        Row: {
          alerts: Json;
          allow_concurrent: boolean;
          created_at: string;
          cron_expr: string | null;
          default_params: Json | null;
          description: string | null;
          dest_catalog_source_id: string | null;
          graph: Json | null;
          id: string;
          is_active: boolean;
          last_run_at: string | null;
          last_run_status: string | null;
          mode: string;
          name: string;
          next_run_at: string | null;
          requirements: string;
          retry_count: number;
          run_after: string | null;
          schedule: string;
          secret_refs: string;
          source_code: string;
          timeout_minutes: number;
          timezone: string | null;
          trigger_token_hash: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alerts?: Json;
          allow_concurrent?: boolean;
          created_at?: string;
          cron_expr?: string | null;
          default_params?: Json | null;
          description?: string | null;
          dest_catalog_source_id?: string | null;
          graph?: Json | null;
          id?: string;
          is_active?: boolean;
          last_run_at?: string | null;
          last_run_status?: string | null;
          mode?: string;
          name: string;
          next_run_at?: string | null;
          requirements?: string;
          retry_count?: number;
          run_after?: string | null;
          schedule?: string;
          secret_refs?: string;
          source_code?: string;
          timeout_minutes?: number;
          timezone?: string | null;
          trigger_token_hash?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alerts?: Json;
          allow_concurrent?: boolean;
          created_at?: string;
          cron_expr?: string | null;
          default_params?: Json | null;
          description?: string | null;
          dest_catalog_source_id?: string | null;
          graph?: Json | null;
          id?: string;
          is_active?: boolean;
          last_run_at?: string | null;
          last_run_status?: string | null;
          mode?: string;
          name?: string;
          next_run_at?: string | null;
          requirements?: string;
          retry_count?: number;
          run_after?: string | null;
          schedule?: string;
          secret_refs?: string;
          source_code?: string;
          timeout_minutes?: number;
          timezone?: string | null;
          trigger_token_hash?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "etl_pipelines_run_after_fkey";
            columns: ["run_after"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      etl_runs: {
        Row: {
          attempt: number;
          created_at: string;
          error: string | null;
          finished_at: string | null;
          id: string;
          logs: string | null;
          metrics: Json | null;
          params: Json | null;
          pipeline_id: string;
          retries_remaining: number;
          retry_at: string | null;
          session_id: string | null;
          source_code: string;
          started_at: string | null;
          status: string;
          trigger: string;
          user_id: string;
        };
        Insert: {
          attempt?: number;
          created_at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          logs?: string | null;
          metrics?: Json | null;
          params?: Json | null;
          pipeline_id: string;
          retries_remaining?: number;
          retry_at?: string | null;
          session_id?: string | null;
          source_code?: string;
          started_at?: string | null;
          status?: string;
          trigger?: string;
          user_id: string;
        };
        Update: {
          attempt?: number;
          created_at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          logs?: string | null;
          metrics?: Json | null;
          params?: Json | null;
          pipeline_id?: string;
          retries_remaining?: number;
          retry_at?: string | null;
          session_id?: string | null;
          source_code?: string;
          started_at?: string | null;
          status?: string;
          trigger?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "etl_runs_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "etl_pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "etl_runs_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "notebook_runtime_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      eval_cases: {
        Row: {
          created_at: string;
          dataset_id: string;
          expected: string | null;
          id: string;
          input: string;
          input_state: Json;
          name: string;
          sort: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          dataset_id: string;
          expected?: string | null;
          id?: string;
          input?: string;
          input_state?: Json;
          name?: string;
          sort?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          dataset_id?: string;
          expected?: string | null;
          id?: string;
          input?: string;
          input_state?: Json;
          name?: string;
          sort?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "eval_cases_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "eval_datasets";
            referencedColumns: ["id"];
          },
        ];
      };
      eval_datasets: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      eval_results: {
        Row: {
          case_expected: string | null;
          case_id: string | null;
          case_input: string;
          case_name: string;
          cost_usd: number;
          created_at: string;
          duration_ms: number;
          error: string | null;
          eval_run_id: string;
          id: string;
          judge: Json | null;
          output: string;
          score: number | null;
          status: string;
          swarm_run_id: string | null;
          user_id: string;
        };
        Insert: {
          case_expected?: string | null;
          case_id?: string | null;
          case_input?: string;
          case_name?: string;
          cost_usd?: number;
          created_at?: string;
          duration_ms?: number;
          error?: string | null;
          eval_run_id: string;
          id?: string;
          judge?: Json | null;
          output?: string;
          score?: number | null;
          status: string;
          swarm_run_id?: string | null;
          user_id: string;
        };
        Update: {
          case_expected?: string | null;
          case_id?: string | null;
          case_input?: string;
          case_name?: string;
          cost_usd?: number;
          created_at?: string;
          duration_ms?: number;
          error?: string | null;
          eval_run_id?: string;
          id?: string;
          judge?: Json | null;
          output?: string;
          score?: number | null;
          status?: string;
          swarm_run_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "eval_results_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "eval_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "eval_results_eval_run_id_fkey";
            columns: ["eval_run_id"];
            isOneToOne: false;
            referencedRelation: "eval_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      eval_runs: {
        Row: {
          avg_score: number | null;
          case_count: number;
          created_at: string;
          dataset_id: string | null;
          dataset_name: string;
          done_count: number;
          error_count: number;
          evaluator: Json;
          fail_count: number;
          finished_at: string | null;
          id: string;
          label: string;
          pass_count: number;
          reject_approvals: boolean;
          started_at: string;
          status: string;
          swarm_id: string | null;
          swarm_name: string;
          swarm_version_id: string | null;
          total_cost_usd: number;
          user_id: string;
        };
        Insert: {
          avg_score?: number | null;
          case_count?: number;
          created_at?: string;
          dataset_id?: string | null;
          dataset_name?: string;
          done_count?: number;
          error_count?: number;
          evaluator: Json;
          fail_count?: number;
          finished_at?: string | null;
          id?: string;
          label?: string;
          pass_count?: number;
          reject_approvals?: boolean;
          started_at?: string;
          status?: string;
          swarm_id?: string | null;
          swarm_name?: string;
          swarm_version_id?: string | null;
          total_cost_usd?: number;
          user_id: string;
        };
        Update: {
          avg_score?: number | null;
          case_count?: number;
          created_at?: string;
          dataset_id?: string | null;
          dataset_name?: string;
          done_count?: number;
          error_count?: number;
          evaluator?: Json;
          fail_count?: number;
          finished_at?: string | null;
          id?: string;
          label?: string;
          pass_count?: number;
          reject_approvals?: boolean;
          started_at?: string;
          status?: string;
          swarm_id?: string | null;
          swarm_name?: string;
          swarm_version_id?: string | null;
          total_cost_usd?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "eval_runs_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "eval_datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "eval_runs_swarm_id_fkey";
            columns: ["swarm_id"];
            isOneToOne: false;
            referencedRelation: "swarms";
            referencedColumns: ["id"];
          },
        ];
      };
      execution_traces: {
        Row: {
          agent_id: string | null;
          agent_name: string;
          cost_scope_id: string | null;
          cost_scope_type: string | null;
          cost_usd: number;
          created_at: string;
          decision_id: string | null;
          error_message: string | null;
          id: string;
          latency_ms: number;
          llm_model: string;
          llm_provider: string;
          parent_trace_id: string | null;
          prompt: string | null;
          request_payload: Json;
          response_payload: Json;
          status: string;
          tokens_in: number;
          tokens_out: number;
          tool_calls: Json;
          user_id: string | null;
        };
        Insert: {
          agent_id?: string | null;
          agent_name: string;
          cost_scope_id?: string | null;
          cost_scope_type?: string | null;
          cost_usd?: number;
          created_at?: string;
          decision_id?: string | null;
          error_message?: string | null;
          id?: string;
          latency_ms?: number;
          llm_model: string;
          llm_provider?: string;
          parent_trace_id?: string | null;
          prompt?: string | null;
          request_payload?: Json;
          response_payload?: Json;
          status?: string;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id?: string | null;
        };
        Update: {
          agent_id?: string | null;
          agent_name?: string;
          cost_scope_id?: string | null;
          cost_scope_type?: string | null;
          cost_usd?: number;
          created_at?: string;
          decision_id?: string | null;
          error_message?: string | null;
          id?: string;
          latency_ms?: number;
          llm_model?: string;
          llm_provider?: string;
          parent_trace_id?: string | null;
          prompt?: string | null;
          request_payload?: Json;
          response_payload?: Json;
          status?: string;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id?: string | null;
        };
        Relationships: [];
      };
      git_export_config: {
        Row: {
          base_path: string;
          branch: string;
          created_at: string;
          host: string | null;
          last_error: string | null;
          last_export_at: string | null;
          last_status: string | null;
          provider: string;
          repo: string;
          token_enc: Json | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          base_path?: string;
          branch?: string;
          created_at?: string;
          host?: string | null;
          last_error?: string | null;
          last_export_at?: string | null;
          last_status?: string | null;
          provider: string;
          repo: string;
          token_enc?: Json | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          base_path?: string;
          branch?: string;
          created_at?: string;
          host?: string | null;
          last_error?: string | null;
          last_export_at?: string | null;
          last_status?: string | null;
          provider?: string;
          repo?: string;
          token_enc?: Json | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      iam_group_members: {
        Row: {
          added_by: string | null;
          created_at: string;
          group_id: string;
          id: string;
          user_id: string;
        };
        Insert: {
          added_by?: string | null;
          created_at?: string;
          group_id: string;
          id?: string;
          user_id: string;
        };
        Update: {
          added_by?: string | null;
          created_at?: string;
          group_id?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "iam_group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "iam_groups";
            referencedColumns: ["id"];
          },
        ];
      };
      iam_groups: {
        Row: {
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      iam_model_rules: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          model_pattern: string;
          principal_id: string;
          principal_type: string;
          provider: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          model_pattern?: string;
          principal_id: string;
          principal_type: string;
          provider: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          model_pattern?: string;
          principal_id?: string;
          principal_type?: string;
          provider?: string;
        };
        Relationships: [];
      };
      iam_resource_grants: {
        Row: {
          column_mask: string[];
          created_at: string;
          created_by: string | null;
          id: string;
          principal_id: string;
          principal_type: string;
          resource_id: string;
          resource_type: string;
          row_filter: Json | null;
        };
        Insert: {
          column_mask?: string[];
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id: string;
          principal_type: string;
          resource_id: string;
          resource_type: string;
          row_filter?: Json | null;
        };
        Update: {
          column_mask?: string[];
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id?: string;
          principal_type?: string;
          resource_id?: string;
          resource_type?: string;
          row_filter?: Json | null;
        };
        Relationships: [];
      };
      iam_settings: {
        Row: {
          allow_public_signup: boolean;
          audit_retention_days: number;
          id: boolean;
          model_access_default: string;
          provenance_retention_days: number;
          sso_enabled: boolean;
          sso_enforced: boolean;
          trace_retention_days: number;
          updated_at: string;
        };
        Insert: {
          allow_public_signup?: boolean;
          audit_retention_days?: number;
          id?: boolean;
          model_access_default?: string;
          provenance_retention_days?: number;
          sso_enabled?: boolean;
          sso_enforced?: boolean;
          trace_retention_days?: number;
          updated_at?: string;
        };
        Update: {
          allow_public_signup?: boolean;
          audit_retention_days?: number;
          id?: boolean;
          model_access_default?: string;
          provenance_retention_days?: number;
          sso_enabled?: boolean;
          sso_enforced?: boolean;
          trace_retention_days?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      iam_user_attributes: {
        Row: {
          attr_values: Json;
          key: string;
          updated_at: string;
          updated_by: string | null;
          user_id: string;
        };
        Insert: {
          attr_values?: Json;
          key: string;
          updated_at?: string;
          updated_by?: string | null;
          user_id: string;
        };
        Update: {
          attr_values?: Json;
          key?: string;
          updated_at?: string;
          updated_by?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      integrations: {
        Row: {
          config: Json;
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          provider: string | null;
          type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          provider?: string | null;
          type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          provider?: string | null;
          type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      kb_chunk_parents: {
        Row: {
          content: string;
          created_at: string;
          document_id: string;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          parent_index: number;
          user_id: string | null;
        };
        Insert: {
          content: string;
          created_at?: string;
          document_id: string;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          parent_index: number;
          user_id?: string | null;
        };
        Update: {
          content?: string;
          created_at?: string;
          document_id?: string;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
          parent_index?: number;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "kb_chunk_parents_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_chunk_parents_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_chunks: {
        Row: {
          chunk_index: number;
          chunk_kind: string;
          content: string;
          created_at: string;
          document_id: string;
          embedding: string;
          fts: unknown;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          parent_id: string | null;
          question: string | null;
          token_estimate: number | null;
          user_id: string;
        };
        Insert: {
          chunk_index: number;
          chunk_kind?: string;
          content: string;
          created_at?: string;
          document_id: string;
          embedding: string;
          fts?: unknown;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          parent_id?: string | null;
          question?: string | null;
          token_estimate?: number | null;
          user_id: string;
        };
        Update: {
          chunk_index?: number;
          chunk_kind?: string;
          content?: string;
          created_at?: string;
          document_id?: string;
          embedding?: string;
          fts?: unknown;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
          parent_id?: string | null;
          question?: string | null;
          token_estimate?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "kb_chunks_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_chunks_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_chunks_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "kb_chunk_parents";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_graph_entities: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          mention_count: number;
          name: string;
          normalized_name: string;
          type: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          mention_count?: number;
          name: string;
          normalized_name: string;
          type?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
          mention_count?: number;
          name?: string;
          normalized_name?: string;
          type?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "kb_graph_entities_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_graph_mentions: {
        Row: {
          char_start: number | null;
          created_at: string;
          document_id: string | null;
          entity_id: string;
          id: string;
          is_sample: boolean;
          snippet: string;
        };
        Insert: {
          char_start?: number | null;
          created_at?: string;
          document_id?: string | null;
          entity_id: string;
          id?: string;
          is_sample?: boolean;
          snippet: string;
        };
        Update: {
          char_start?: number | null;
          created_at?: string;
          document_id?: string | null;
          entity_id?: string;
          id?: string;
          is_sample?: boolean;
          snippet?: string;
        };
        Relationships: [
          {
            foreignKeyName: "kb_graph_mentions_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_graph_mentions_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "kb_graph_entities";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_graph_relations: {
        Row: {
          created_at: string;
          document_id: string | null;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          predicate: string;
          source_entity_id: string;
          target_entity_id: string;
          user_id: string | null;
          weight: number;
        };
        Insert: {
          created_at?: string;
          document_id?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          predicate: string;
          source_entity_id: string;
          target_entity_id: string;
          user_id?: string | null;
          weight?: number;
        };
        Update: {
          created_at?: string;
          document_id?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
          predicate?: string;
          source_entity_id?: string;
          target_entity_id?: string;
          user_id?: string | null;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "kb_graph_relations_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_graph_relations_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_graph_relations_source_entity_id_fkey";
            columns: ["source_entity_id"];
            isOneToOne: false;
            referencedRelation: "kb_graph_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_graph_relations_target_entity_id_fkey";
            columns: ["target_entity_id"];
            isOneToOne: false;
            referencedRelation: "kb_graph_entities";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_sources: {
        Row: {
          access_scope: string;
          config: Json;
          created_at: string;
          credentials: Json | null;
          error: string | null;
          id: string;
          is_sample: boolean;
          kind: string;
          knowledge_base_id: string;
          label: string | null;
          last_sync_stats: Json | null;
          last_synced_at: string | null;
          next_sync_at: string | null;
          status: string;
          sync_schedule: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          access_scope?: string;
          config?: Json;
          created_at?: string;
          credentials?: Json | null;
          error?: string | null;
          id?: string;
          is_sample?: boolean;
          kind: string;
          knowledge_base_id: string;
          label?: string | null;
          last_sync_stats?: Json | null;
          last_synced_at?: string | null;
          next_sync_at?: string | null;
          status?: string;
          sync_schedule?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          access_scope?: string;
          config?: Json;
          created_at?: string;
          credentials?: Json | null;
          error?: string | null;
          id?: string;
          is_sample?: boolean;
          kind?: string;
          knowledge_base_id?: string;
          label?: string | null;
          last_sync_stats?: Json | null;
          last_synced_at?: string | null;
          next_sync_at?: string | null;
          status?: string;
          sync_schedule?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "kb_sources_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
        ];
      };
      knowledge_bases: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_sample: boolean;
          kb_graph_built_at: string | null;
          kb_graph_error: string | null;
          kb_graph_status: string | null;
          name: string;
          retrieval_settings: Json | null;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_sample?: boolean;
          kb_graph_built_at?: string | null;
          kb_graph_error?: string | null;
          kb_graph_status?: string | null;
          name: string;
          retrieval_settings?: Json | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_sample?: boolean;
          kb_graph_built_at?: string | null;
          kb_graph_error?: string | null;
          kb_graph_status?: string | null;
          name?: string;
          retrieval_settings?: Json | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      knowledge_documents: {
        Row: {
          acl_principals: string[] | null;
          content: string | null;
          content_hash: string | null;
          created_at: string;
          external_id: string | null;
          file_url: string | null;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          metadata: Json | null;
          name: string;
          source_id: string | null;
          user_id: string | null;
        };
        Insert: {
          acl_principals?: string[] | null;
          content?: string | null;
          content_hash?: string | null;
          created_at?: string;
          external_id?: string | null;
          file_url?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          metadata?: Json | null;
          name: string;
          source_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          acl_principals?: string[] | null;
          content?: string | null;
          content_hash?: string | null;
          created_at?: string;
          external_id?: string | null;
          file_url?: string | null;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
          metadata?: Json | null;
          name?: string;
          source_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_knowledge_base_id_fkey";
            columns: ["knowledge_base_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "knowledge_documents_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "kb_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      lakehouse_materialized_views: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          last_duration_ms: number | null;
          last_error: string | null;
          last_refreshed_at: string | null;
          last_row_count: number | null;
          last_status: string | null;
          next_run_at: string | null;
          schedule: string;
          schema_name: string;
          sql: string;
          table_name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_duration_ms?: number | null;
          last_error?: string | null;
          last_refreshed_at?: string | null;
          last_row_count?: number | null;
          last_status?: string | null;
          next_run_at?: string | null;
          schedule?: string;
          schema_name: string;
          sql: string;
          table_name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_duration_ms?: number | null;
          last_error?: string | null;
          last_refreshed_at?: string | null;
          last_row_count?: number | null;
          last_status?: string | null;
          next_run_at?: string | null;
          schedule?: string;
          schema_name?: string;
          sql?: string;
          table_name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      lakehouse_query_history: {
        Row: {
          cached: boolean;
          created_at: string;
          duration_ms: number | null;
          error: string | null;
          id: number;
          kind: string;
          retries: number;
          row_count: number | null;
          rows_scanned: number | null;
          sql: string;
          status: string;
          user_id: string;
        };
        Insert: {
          cached?: boolean;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: number;
          kind: string;
          retries?: number;
          row_count?: number | null;
          rows_scanned?: number | null;
          sql: string;
          status: string;
          user_id: string;
        };
        Update: {
          cached?: boolean;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: number;
          kind?: string;
          retries?: number;
          row_count?: number | null;
          rows_scanned?: number | null;
          sql?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      lakehouse_schemas: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          lake_source_id: string | null;
          name: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          lake_source_id?: string | null;
          name: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          lake_source_id?: string | null;
          name?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lakehouse_schemas_lake_source_id_fkey";
            columns: ["lake_source_id"];
            isOneToOne: false;
            referencedRelation: "catalog_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      lakehouse_table_policies: {
        Row: {
          created_at: string;
          id: string;
          mask_style: string;
          masked_columns: string[];
          row_filter: string | null;
          schema_name: string;
          table_name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          mask_style?: string;
          masked_columns?: string[];
          row_filter?: string | null;
          schema_name: string;
          table_name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          mask_style?: string;
          masked_columns?: string[];
          row_filter?: string | null;
          schema_name?: string;
          table_name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      mcp_app_keys: {
        Row: {
          app_id: string;
          created_at: string;
          expires_at: string | null;
          id: string;
          ip_allowlist: string[];
          is_active: boolean;
          is_internal: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          last_used_ip: string | null;
          name: string;
          revoked_at: string | null;
          tool_allowlist: string[];
          updated_at: string;
          use_count: number;
          user_id: string;
        };
        Insert: {
          app_id: string;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          ip_allowlist?: string[];
          is_active?: boolean;
          is_internal?: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name: string;
          revoked_at?: string | null;
          tool_allowlist?: string[];
          updated_at?: string;
          use_count?: number;
          user_id: string;
        };
        Update: {
          app_id?: string;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          ip_allowlist?: string[];
          is_active?: boolean;
          is_internal?: boolean;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name?: string;
          revoked_at?: string | null;
          tool_allowlist?: string[];
          updated_at?: string;
          use_count?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_app_keys_app_id_fkey";
            columns: ["app_id"];
            isOneToOne: false;
            referencedRelation: "mcp_apps";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_app_sessions: {
        Row: {
          app_id: string;
          created_at: string;
          id: string;
          key_id: string | null;
          last_seen_at: string;
          runtime_session_id: string | null;
          upstream_session_id: string | null;
        };
        Insert: {
          app_id: string;
          created_at?: string;
          id?: string;
          key_id?: string | null;
          last_seen_at?: string;
          runtime_session_id?: string | null;
          upstream_session_id?: string | null;
        };
        Update: {
          app_id?: string;
          created_at?: string;
          id?: string;
          key_id?: string | null;
          last_seen_at?: string;
          runtime_session_id?: string | null;
          upstream_session_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_app_sessions_app_id_fkey";
            columns: ["app_id"];
            isOneToOne: false;
            referencedRelation: "mcp_apps";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_app_sessions_key_id_fkey";
            columns: ["key_id"];
            isOneToOne: false;
            referencedRelation: "mcp_app_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_app_sessions_runtime_session_id_fkey";
            columns: ["runtime_session_id"];
            isOneToOne: false;
            referencedRelation: "notebook_runtime_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_app_versions: {
        Row: {
          app_id: string;
          created_at: string;
          id: string;
          note: string | null;
          requirements: string;
          source_code: string;
          tools: Json;
          user_id: string;
          version: number;
        };
        Insert: {
          app_id: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          requirements?: string;
          source_code?: string;
          tools?: Json;
          user_id: string;
          version: number;
        };
        Update: {
          app_id?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          requirements?: string;
          source_code?: string;
          tools?: Json;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_app_versions_app_id_fkey";
            columns: ["app_id"];
            isOneToOne: false;
            referencedRelation: "mcp_apps";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_apps: {
        Row: {
          allowed_origins: string[];
          created_at: string;
          deploy_error: string | null;
          description: string;
          id: string;
          idle_ttl_minutes: number;
          is_public: boolean;
          keep_warm: boolean;
          last_deployed_at: string | null;
          name: string;
          registered_server_id: string | null;
          requested_egress_hosts: string[];
          requirements: string;
          secret_refs: string[];
          slug: string;
          source_code: string;
          status: string;
          tools: Json;
          tools_approved_at: string | null;
          tools_changed_at: string | null;
          tools_hash: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          allowed_origins?: string[];
          created_at?: string;
          deploy_error?: string | null;
          description?: string;
          id?: string;
          idle_ttl_minutes?: number;
          is_public?: boolean;
          keep_warm?: boolean;
          last_deployed_at?: string | null;
          name: string;
          registered_server_id?: string | null;
          requested_egress_hosts?: string[];
          requirements?: string;
          secret_refs?: string[];
          slug: string;
          source_code?: string;
          status?: string;
          tools?: Json;
          tools_approved_at?: string | null;
          tools_changed_at?: string | null;
          tools_hash?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          allowed_origins?: string[];
          created_at?: string;
          deploy_error?: string | null;
          description?: string;
          id?: string;
          idle_ttl_minutes?: number;
          is_public?: boolean;
          keep_warm?: boolean;
          last_deployed_at?: string | null;
          name?: string;
          registered_server_id?: string | null;
          requested_egress_hosts?: string[];
          requirements?: string;
          secret_refs?: string[];
          slug?: string;
          source_code?: string;
          status?: string;
          tools?: Json;
          tools_approved_at?: string | null;
          tools_changed_at?: string | null;
          tools_hash?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_apps_registered_server_id_fkey";
            columns: ["registered_server_id"];
            isOneToOne: false;
            referencedRelation: "mcp_servers";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_servers: {
        Row: {
          auth_token: string | null;
          auth_token_enc: Json | null;
          auth_type: string;
          created_at: string;
          description: string | null;
          endpoint: string;
          id: string;
          last_ping: string | null;
          name: string;
          status: string;
          tools: Json;
          tools_count: number;
          type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          auth_token?: string | null;
          auth_token_enc?: Json | null;
          auth_type?: string;
          created_at?: string;
          description?: string | null;
          endpoint: string;
          id?: string;
          last_ping?: string | null;
          name: string;
          status?: string;
          tools?: Json;
          tools_count?: number;
          type?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          auth_token?: string | null;
          auth_token_enc?: Json | null;
          auth_type?: string;
          created_at?: string;
          description?: string | null;
          endpoint?: string;
          id?: string;
          last_ping?: string | null;
          name?: string;
          status?: string;
          tools?: Json;
          tools_count?: number;
          type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string;
          id: string;
          metadata: Json | null;
          role: string;
          user_id: string;
        };
        Insert: {
          content: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          metadata?: Json | null;
          role: string;
          user_id: string;
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          metadata?: Json | null;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      ml_api_keys: {
        Row: {
          created_at: string;
          expires_at: string | null;
          id: string;
          is_active: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          last_used_ip: string | null;
          model_id: string;
          name: string;
          revoked_at: string | null;
          scopes: string[];
          updated_at: string;
          use_count: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          model_id: string;
          name: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          use_count?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          model_id?: string;
          name?: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          use_count?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ml_api_keys_model_id_fkey";
            columns: ["model_id"];
            isOneToOne: false;
            referencedRelation: "ml_models";
            referencedColumns: ["id"];
          },
        ];
      };
      ml_model_versions: {
        Row: {
          algorithm: string | null;
          artifact_bytes: number | null;
          artifact_sha256: string | null;
          artifact_uri: string | null;
          config: Json;
          created_at: string;
          decision_id: string | null;
          external: boolean;
          feature_importance: Json;
          feature_schema: Json;
          forecast: Json | null;
          id: string;
          leaderboard: Json;
          metrics: Json;
          model_id: string;
          stage: string;
          status: string;
          trained_at: string | null;
          training_rows: number | null;
          training_sampled: boolean;
          training_snapshot_id: number | null;
          training_total_rows: number | null;
          user_id: string;
          version: number;
          warnings: Json;
        };
        Insert: {
          algorithm?: string | null;
          artifact_bytes?: number | null;
          artifact_sha256?: string | null;
          artifact_uri?: string | null;
          config?: Json;
          created_at?: string;
          decision_id?: string | null;
          external?: boolean;
          feature_importance?: Json;
          feature_schema?: Json;
          forecast?: Json | null;
          id?: string;
          leaderboard?: Json;
          metrics?: Json;
          model_id: string;
          stage?: string;
          status?: string;
          trained_at?: string | null;
          training_rows?: number | null;
          training_sampled?: boolean;
          training_snapshot_id?: number | null;
          training_total_rows?: number | null;
          user_id: string;
          version: number;
          warnings?: Json;
        };
        Update: {
          algorithm?: string | null;
          artifact_bytes?: number | null;
          artifact_sha256?: string | null;
          artifact_uri?: string | null;
          config?: Json;
          created_at?: string;
          decision_id?: string | null;
          external?: boolean;
          feature_importance?: Json;
          feature_schema?: Json;
          forecast?: Json | null;
          id?: string;
          leaderboard?: Json;
          metrics?: Json;
          model_id?: string;
          stage?: string;
          status?: string;
          trained_at?: string | null;
          training_rows?: number | null;
          training_sampled?: boolean;
          training_snapshot_id?: number | null;
          training_total_rows?: number | null;
          user_id?: string;
          version?: number;
          warnings?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "ml_model_versions_model_id_fkey";
            columns: ["model_id"];
            isOneToOne: false;
            referencedRelation: "ml_models";
            referencedColumns: ["id"];
          },
        ];
      };
      ml_models: {
        Row: {
          aggregation: string | null;
          contamination: number | null;
          created_at: string;
          description: string | null;
          feature_columns: string[] | null;
          horizon: number | null;
          id: string;
          item_column: string | null;
          n_clusters: number | null;
          name: string;
          prep: Json;
          production_version_id: string | null;
          rating_column: string | null;
          source: Json;
          target_column: string | null;
          task: string;
          time_column: string | null;
          updated_at: string;
          user_column: string | null;
          user_id: string;
        };
        Insert: {
          aggregation?: string | null;
          contamination?: number | null;
          created_at?: string;
          description?: string | null;
          feature_columns?: string[] | null;
          horizon?: number | null;
          id?: string;
          item_column?: string | null;
          n_clusters?: number | null;
          name: string;
          prep?: Json;
          production_version_id?: string | null;
          rating_column?: string | null;
          source: Json;
          target_column?: string | null;
          task: string;
          time_column?: string | null;
          updated_at?: string;
          user_column?: string | null;
          user_id: string;
        };
        Update: {
          aggregation?: string | null;
          contamination?: number | null;
          created_at?: string;
          description?: string | null;
          feature_columns?: string[] | null;
          horizon?: number | null;
          id?: string;
          item_column?: string | null;
          n_clusters?: number | null;
          name?: string;
          prep?: Json;
          production_version_id?: string | null;
          rating_column?: string | null;
          source?: Json;
          target_column?: string | null;
          task?: string;
          time_column?: string | null;
          updated_at?: string;
          user_column?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ml_models_production_version_fk";
            columns: ["production_version_id"];
            isOneToOne: false;
            referencedRelation: "ml_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      ml_predictions: {
        Row: {
          api_key_id: string | null;
          created_at: string;
          decision_id: string | null;
          error: string | null;
          finished_at: string | null;
          id: string;
          input: Json;
          kind: string;
          logs: string | null;
          model_id: string;
          output: Json | null;
          result: Json | null;
          row_count: number | null;
          session_id: string | null;
          started_at: string | null;
          status: string;
          user_id: string;
          version_id: string;
          via: string;
        };
        Insert: {
          api_key_id?: string | null;
          created_at?: string;
          decision_id?: string | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          input: Json;
          kind?: string;
          logs?: string | null;
          model_id: string;
          output?: Json | null;
          result?: Json | null;
          row_count?: number | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: string;
          user_id: string;
          version_id: string;
          via?: string;
        };
        Update: {
          api_key_id?: string | null;
          created_at?: string;
          decision_id?: string | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json;
          kind?: string;
          logs?: string | null;
          model_id?: string;
          output?: Json | null;
          result?: Json | null;
          row_count?: number | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: string;
          user_id?: string;
          version_id?: string;
          via?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ml_predictions_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "ml_api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ml_predictions_model_id_fkey";
            columns: ["model_id"];
            isOneToOne: false;
            referencedRelation: "ml_models";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ml_predictions_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "ml_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      ml_training_jobs: {
        Row: {
          api_key_id: string | null;
          created_at: string;
          error: string | null;
          finished_at: string | null;
          id: string;
          logs: string | null;
          model_id: string;
          result: Json | null;
          session_id: string | null;
          started_at: string | null;
          status: string;
          trigger: string;
          user_id: string;
          version_id: string;
        };
        Insert: {
          api_key_id?: string | null;
          created_at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          logs?: string | null;
          model_id: string;
          result?: Json | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: string;
          trigger?: string;
          user_id: string;
          version_id: string;
        };
        Update: {
          api_key_id?: string | null;
          created_at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          logs?: string | null;
          model_id?: string;
          result?: Json | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: string;
          trigger?: string;
          user_id?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ml_training_jobs_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "ml_api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ml_training_jobs_model_id_fkey";
            columns: ["model_id"];
            isOneToOne: false;
            referencedRelation: "ml_models";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ml_training_jobs_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "ml_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      model_registry: {
        Row: {
          alias: string | null;
          capabilities: string[];
          context_length: number | null;
          created_at: string;
          description: string | null;
          developer: string;
          display_name: string;
          docs_url: string | null;
          id: string;
          last_seen_at: string;
          modality: string;
          model_id: string;
          output_max: number | null;
          provider_slug: string;
          raw: Json;
          source: string;
          updated_at: string;
        };
        Insert: {
          alias?: string | null;
          capabilities?: string[];
          context_length?: number | null;
          created_at?: string;
          description?: string | null;
          developer: string;
          display_name: string;
          docs_url?: string | null;
          id?: string;
          last_seen_at?: string;
          modality?: string;
          model_id: string;
          output_max?: number | null;
          provider_slug: string;
          raw?: Json;
          source?: string;
          updated_at?: string;
        };
        Update: {
          alias?: string | null;
          capabilities?: string[];
          context_length?: number | null;
          created_at?: string;
          description?: string | null;
          developer?: string;
          display_name?: string;
          docs_url?: string | null;
          id?: string;
          last_seen_at?: string;
          modality?: string;
          model_id?: string;
          output_max?: number | null;
          provider_slug?: string;
          raw?: Json;
          source?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      model_registry_meta: {
        Row: {
          id: number;
          last_sync_count: number | null;
          last_sync_error: string | null;
          last_sync_status: string | null;
          last_synced_at: string | null;
        };
        Insert: {
          id?: number;
          last_sync_count?: number | null;
          last_sync_error?: string | null;
          last_sync_status?: string | null;
          last_synced_at?: string | null;
        };
        Update: {
          id?: number;
          last_sync_count?: number | null;
          last_sync_error?: string | null;
          last_sync_status?: string | null;
          last_synced_at?: string | null;
        };
        Relationships: [];
      };
      notebook_api_keys: {
        Row: {
          created_at: string;
          entrypoint: string;
          expires_at: string | null;
          id: string;
          is_active: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          last_used_ip: string | null;
          name: string;
          notebook_id: string;
          revoked_at: string | null;
          rotated_from: string | null;
          updated_at: string;
          use_count: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          entrypoint?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name: string;
          notebook_id: string;
          revoked_at?: string | null;
          rotated_from?: string | null;
          updated_at?: string;
          use_count?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          entrypoint?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name?: string;
          notebook_id?: string;
          revoked_at?: string | null;
          rotated_from?: string | null;
          updated_at?: string;
          use_count?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notebook_api_keys_notebook_id_fkey";
            columns: ["notebook_id"];
            isOneToOne: false;
            referencedRelation: "user_python_notebooks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notebook_api_keys_rotated_from_fkey";
            columns: ["rotated_from"];
            isOneToOne: false;
            referencedRelation: "notebook_api_keys";
            referencedColumns: ["id"];
          },
        ];
      };
      notebook_git_versions: {
        Row: {
          branch: string;
          commit_sha: string;
          commit_url: string | null;
          content_hash: string;
          created_at: string;
          file_path: string;
          id: string;
          message: string;
          notebook_id: string;
          provider: string;
          repo: string;
          user_id: string;
        };
        Insert: {
          branch: string;
          commit_sha: string;
          commit_url?: string | null;
          content_hash: string;
          created_at?: string;
          file_path: string;
          id?: string;
          message: string;
          notebook_id: string;
          provider: string;
          repo: string;
          user_id: string;
        };
        Update: {
          branch?: string;
          commit_sha?: string;
          commit_url?: string | null;
          content_hash?: string;
          created_at?: string;
          file_path?: string;
          id?: string;
          message?: string;
          notebook_id?: string;
          provider?: string;
          repo?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notebook_git_versions_notebook_id_fkey";
            columns: ["notebook_id"];
            isOneToOne: false;
            referencedRelation: "user_python_notebooks";
            referencedColumns: ["id"];
          },
        ];
      };
      notebook_runtime_grants: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          principal_id: string;
          principal_type: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id: string;
          principal_type: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          principal_id?: string;
          principal_type?: string;
        };
        Relationships: [];
      };
      notebook_runtime_secrets: {
        Row: {
          created_at: string;
          id: boolean;
          signing_secret: string;
        };
        Insert: {
          created_at?: string;
          id?: boolean;
          signing_secret: string;
        };
        Update: {
          created_at?: string;
          id?: boolean;
          signing_secret?: string;
        };
        Relationships: [];
      };
      notebook_runtime_sessions: {
        Row: {
          api_key_id: string | null;
          backend: string;
          container_ref: string | null;
          cpu_limit: string | null;
          created_at: string;
          endpoint: string | null;
          entrypoint: string | null;
          error: string | null;
          etl_run_id: string | null;
          expires_at: string | null;
          id: string;
          image: string | null;
          inputs: Json | null;
          kind: string;
          last_active_at: string;
          logs: string | null;
          mcp_app_id: string | null;
          mem_limit_mb: number | null;
          notebook_id: string | null;
          result: Json | null;
          started_at: string | null;
          status: string;
          stopped_at: string | null;
          user_id: string;
        };
        Insert: {
          api_key_id?: string | null;
          backend?: string;
          container_ref?: string | null;
          cpu_limit?: string | null;
          created_at?: string;
          endpoint?: string | null;
          entrypoint?: string | null;
          error?: string | null;
          etl_run_id?: string | null;
          expires_at?: string | null;
          id?: string;
          image?: string | null;
          inputs?: Json | null;
          kind?: string;
          last_active_at?: string;
          logs?: string | null;
          mcp_app_id?: string | null;
          mem_limit_mb?: number | null;
          notebook_id?: string | null;
          result?: Json | null;
          started_at?: string | null;
          status?: string;
          stopped_at?: string | null;
          user_id: string;
        };
        Update: {
          api_key_id?: string | null;
          backend?: string;
          container_ref?: string | null;
          cpu_limit?: string | null;
          created_at?: string;
          endpoint?: string | null;
          entrypoint?: string | null;
          error?: string | null;
          etl_run_id?: string | null;
          expires_at?: string | null;
          id?: string;
          image?: string | null;
          inputs?: Json | null;
          kind?: string;
          last_active_at?: string;
          logs?: string | null;
          mcp_app_id?: string | null;
          mem_limit_mb?: number | null;
          notebook_id?: string | null;
          result?: Json | null;
          started_at?: string | null;
          status?: string;
          stopped_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notebook_runtime_sessions_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "notebook_api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notebook_runtime_sessions_etl_run_id_fkey";
            columns: ["etl_run_id"];
            isOneToOne: false;
            referencedRelation: "etl_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notebook_runtime_sessions_mcp_app_id_fkey";
            columns: ["mcp_app_id"];
            isOneToOne: false;
            referencedRelation: "mcp_apps";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notebook_runtime_sessions_notebook_id_fkey";
            columns: ["notebook_id"];
            isOneToOne: false;
            referencedRelation: "user_python_notebooks";
            referencedColumns: ["id"];
          },
        ];
      };
      notebook_runtime_settings: {
        Row: {
          backend: string;
          batch_cpu_limit: string;
          batch_max_minutes: number;
          batch_mem_limit_mb: number;
          cell_timeout_seconds: number;
          cpu_limit: string;
          default_image: string;
          egress_allowlist: string[];
          etl_max_concurrent_runs_per_user: number | null;
          etl_pipelines_per_sweep: number | null;
          id: boolean;
          idle_ttl_minutes: number;
          lakehouse_memory_limit: string | null;
          lakehouse_threads: number | null;
          max_sessions_per_user: number;
          max_sessions_total: number;
          mem_limit_mb: number;
          ml_max_concurrent_trainings_per_user: number | null;
          ml_predict_max_rows: number | null;
          ml_train_max_rows: number | null;
          ml_train_mem_limit_mb: number | null;
          ml_train_time_budget_minutes: number | null;
          pip_allowed: boolean;
          require_grant: boolean;
          sandbox_tmpfs_mb: number | null;
          server_runtime_enabled: boolean;
          session_max_minutes: number;
          updated_at: string;
        };
        Insert: {
          backend?: string;
          batch_cpu_limit?: string;
          batch_max_minutes?: number;
          batch_mem_limit_mb?: number;
          cell_timeout_seconds?: number;
          cpu_limit?: string;
          default_image?: string;
          egress_allowlist?: string[];
          etl_max_concurrent_runs_per_user?: number | null;
          etl_pipelines_per_sweep?: number | null;
          id?: boolean;
          idle_ttl_minutes?: number;
          lakehouse_memory_limit?: string | null;
          lakehouse_threads?: number | null;
          max_sessions_per_user?: number;
          max_sessions_total?: number;
          mem_limit_mb?: number;
          ml_max_concurrent_trainings_per_user?: number | null;
          ml_predict_max_rows?: number | null;
          ml_train_max_rows?: number | null;
          ml_train_mem_limit_mb?: number | null;
          ml_train_time_budget_minutes?: number | null;
          pip_allowed?: boolean;
          require_grant?: boolean;
          sandbox_tmpfs_mb?: number | null;
          server_runtime_enabled?: boolean;
          session_max_minutes?: number;
          updated_at?: string;
        };
        Update: {
          backend?: string;
          batch_cpu_limit?: string;
          batch_max_minutes?: number;
          batch_mem_limit_mb?: number;
          cell_timeout_seconds?: number;
          cpu_limit?: string;
          default_image?: string;
          egress_allowlist?: string[];
          etl_max_concurrent_runs_per_user?: number | null;
          etl_pipelines_per_sweep?: number | null;
          id?: boolean;
          idle_ttl_minutes?: number;
          lakehouse_memory_limit?: string | null;
          lakehouse_threads?: number | null;
          max_sessions_per_user?: number;
          max_sessions_total?: number;
          mem_limit_mb?: number;
          ml_max_concurrent_trainings_per_user?: number | null;
          ml_predict_max_rows?: number | null;
          ml_train_max_rows?: number | null;
          ml_train_mem_limit_mb?: number | null;
          ml_train_time_budget_minutes?: number | null;
          pip_allowed?: boolean;
          require_grant?: boolean;
          sandbox_tmpfs_mb?: number | null;
          server_runtime_enabled?: boolean;
          session_max_minutes?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          kind: string;
          link: string | null;
          read_at: string | null;
          title: string;
          user_id: string;
        };
        Insert: {
          body?: string;
          created_at?: string;
          id?: string;
          kind?: string;
          link?: string | null;
          read_at?: string | null;
          title: string;
          user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          kind?: string;
          link?: string | null;
          read_at?: string | null;
          title?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      otel_export_cursor: {
        Row: {
          last_id: string;
          last_ts: string;
          stream: string;
          updated_at: string;
        };
        Insert: {
          last_id?: string;
          last_ts?: string;
          stream: string;
          updated_at?: string;
        };
        Update: {
          last_id?: string;
          last_ts?: string;
          stream?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          created_at: string;
          designation: string | null;
          display_name: string | null;
          first_name: string | null;
          id: string;
          last_name: string | null;
          organization: string | null;
          role: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          designation?: string | null;
          display_name?: string | null;
          first_name?: string | null;
          id?: string;
          last_name?: string | null;
          organization?: string | null;
          role?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          designation?: string | null;
          display_name?: string | null;
          first_name?: string | null;
          id?: string;
          last_name?: string | null;
          organization?: string | null;
          role?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      provider_credentials: {
        Row: {
          config: Json;
          created_at: string;
          credentials: Json;
          default_model: string | null;
          id: string;
          is_active: boolean;
          label: string;
          last_test_error: string | null;
          last_test_status: string | null;
          last_tested_at: string | null;
          provider: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          credentials?: Json;
          default_model?: string | null;
          id?: string;
          is_active?: boolean;
          label?: string;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          provider: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          credentials?: Json;
          default_model?: string | null;
          id?: string;
          is_active?: boolean;
          label?: string;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          provider?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      rate_limit_hits: {
        Row: {
          at: string;
          bucket: string;
          id: number;
        };
        Insert: {
          at?: string;
          bucket: string;
          id?: number;
        };
        Update: {
          at?: string;
          bucket?: string;
          id?: number;
        };
        Relationships: [];
      };
      saas_connections: {
        Row: {
          config: Json;
          created_at: string;
          credentials_rotated_at: string | null;
          id: string;
          is_active: boolean;
          last_sync_error: string | null;
          last_sync_status: string | null;
          last_synced_at: string | null;
          last_test_error: string | null;
          last_test_status: string | null;
          last_tested_at: string | null;
          name: string;
          next_sync_at: string | null;
          provider: string;
          streams: Json;
          sync_schedule: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          credentials_rotated_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_sync_error?: string | null;
          last_sync_status?: string | null;
          last_synced_at?: string | null;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          name: string;
          next_sync_at?: string | null;
          provider: string;
          streams?: Json;
          sync_schedule?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          credentials_rotated_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_sync_error?: string | null;
          last_sync_status?: string | null;
          last_synced_at?: string | null;
          last_test_error?: string | null;
          last_test_status?: string | null;
          last_tested_at?: string | null;
          name?: string;
          next_sync_at?: string | null;
          provider?: string;
          streams?: Json;
          sync_schedule?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      semantic_model_versions: {
        Row: {
          changed_by: string | null;
          created_at: string;
          definition: Json;
          id: string;
          model_id: string;
          user_id: string;
        };
        Insert: {
          changed_by?: string | null;
          created_at?: string;
          definition: Json;
          id?: string;
          model_id: string;
          user_id: string;
        };
        Update: {
          changed_by?: string | null;
          created_at?: string;
          definition?: Json;
          id?: string;
          model_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "semantic_model_versions_model_id_fkey";
            columns: ["model_id"];
            isOneToOne: false;
            referencedRelation: "semantic_models";
            referencedColumns: ["id"];
          },
        ];
      };
      semantic_models: {
        Row: {
          assertions: Json;
          calendar: Json | null;
          certified_at: string | null;
          certified_by: string | null;
          connection_id: string | null;
          created_at: string;
          description: string | null;
          dimensions: Json;
          fiscal_year_start_month: number | null;
          hierarchies: Json;
          id: string;
          joins: Json;
          label: string | null;
          metrics: Json;
          name: string;
          parameters: Json;
          primary_key: string | null;
          rollups: Json | null;
          source_kind: string;
          source_table: string;
          status: string;
          table_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          assertions?: Json;
          calendar?: Json | null;
          certified_at?: string | null;
          certified_by?: string | null;
          connection_id?: string | null;
          created_at?: string;
          description?: string | null;
          dimensions?: Json;
          fiscal_year_start_month?: number | null;
          hierarchies?: Json;
          id?: string;
          joins?: Json;
          label?: string | null;
          metrics?: Json;
          name: string;
          parameters?: Json;
          primary_key?: string | null;
          rollups?: Json | null;
          source_kind: string;
          source_table: string;
          status?: string;
          table_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          assertions?: Json;
          calendar?: Json | null;
          certified_at?: string | null;
          certified_by?: string | null;
          connection_id?: string | null;
          created_at?: string;
          description?: string | null;
          dimensions?: Json;
          fiscal_year_start_month?: number | null;
          hierarchies?: Json;
          id?: string;
          joins?: Json;
          label?: string | null;
          metrics?: Json;
          name?: string;
          parameters?: Json;
          primary_key?: string | null;
          rollups?: Json | null;
          source_kind?: string;
          source_table?: string;
          status?: string;
          table_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "semantic_models_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "data_warehouse_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "semantic_models_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      slack_workspaces: {
        Row: {
          analyst_id: string | null;
          bot_token_enc: Json | null;
          created_at: string;
          id: string;
          is_active: boolean;
          last_command_at: string | null;
          last_error: string | null;
          signing_secret_enc: Json | null;
          team_id: string;
          team_name: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          analyst_id?: string | null;
          bot_token_enc?: Json | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_command_at?: string | null;
          last_error?: string | null;
          signing_secret_enc?: Json | null;
          team_id: string;
          team_name?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          analyst_id?: string | null;
          bot_token_enc?: Json | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_command_at?: string | null;
          last_error?: string | null;
          signing_secret_enc?: Json | null;
          team_id?: string;
          team_name?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "slack_workspaces_analyst_id_fkey";
            columns: ["analyst_id"];
            isOneToOne: false;
            referencedRelation: "ai_analysts";
            referencedColumns: ["id"];
          },
        ];
      };
      sql_query_history: {
        Row: {
          connection_id: string | null;
          connection_name: string | null;
          created_at: string;
          duration_ms: number | null;
          error: string | null;
          id: string;
          row_count: number | null;
          source: string;
          sql: string;
          user_id: string;
        };
        Insert: {
          connection_id?: string | null;
          connection_name?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          row_count?: number | null;
          source?: string;
          sql: string;
          user_id: string;
        };
        Update: {
          connection_id?: string | null;
          connection_name?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          row_count?: number | null;
          source?: string;
          sql?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      suppressed_emails: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          metadata: Json | null;
          reason: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          metadata?: Json | null;
          reason: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          metadata?: Json | null;
          reason?: string;
        };
        Relationships: [];
      };
      swarm_api_keys: {
        Row: {
          callback_url: string | null;
          created_at: string;
          expires_at: string | null;
          id: string;
          is_active: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          last_used_ip: string | null;
          name: string;
          reject_approvals: boolean;
          revoked_at: string | null;
          rotated_from: string | null;
          scopes: string[];
          swarm_id: string;
          updated_at: string;
          use_count: number;
          user_id: string;
          webhook_secret: string | null;
        };
        Insert: {
          callback_url?: string | null;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name: string;
          reject_approvals?: boolean;
          revoked_at?: string | null;
          rotated_from?: string | null;
          scopes?: string[];
          swarm_id: string;
          updated_at?: string;
          use_count?: number;
          user_id: string;
          webhook_secret?: string | null;
        };
        Update: {
          callback_url?: string | null;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          is_active?: boolean;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          last_used_ip?: string | null;
          name?: string;
          reject_approvals?: boolean;
          revoked_at?: string | null;
          rotated_from?: string | null;
          scopes?: string[];
          swarm_id?: string;
          updated_at?: string;
          use_count?: number;
          user_id?: string;
          webhook_secret?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_api_keys_rotated_from_fkey";
            columns: ["rotated_from"];
            isOneToOne: false;
            referencedRelation: "swarm_api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "swarm_api_keys_swarm_id_fkey";
            columns: ["swarm_id"];
            isOneToOne: false;
            referencedRelation: "swarms";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_chats: {
        Row: {
          created_at: string;
          id: string;
          messages: Json;
          state: Json;
          swarm_id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          messages?: Json;
          state?: Json;
          swarm_id: string;
          title?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          messages?: Json;
          state?: Json;
          swarm_id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_chats_swarm_id_fkey";
            columns: ["swarm_id"];
            isOneToOne: false;
            referencedRelation: "swarms";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_components: {
        Row: {
          category: string;
          code: string;
          created_at: string;
          description: string;
          id: string;
          name: string;
          params: Json;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          category?: string;
          code?: string;
          created_at?: string;
          description?: string;
          id?: string;
          name: string;
          params?: Json;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          category?: string;
          code?: string;
          created_at?: string;
          description?: string;
          id?: string;
          name?: string;
          params?: Json;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      swarm_run_checkpoints: {
        Row: {
          completed_node_ids: string[];
          created_at: string;
          ctx: Json;
          dead_edge_ids: string[];
          depth: number;
          last_output: string;
          level_index: number;
          run_id: string;
          skipped_node_ids: string[];
          source: string;
          suspended_at: string | null;
          suspended_node_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed_node_ids?: string[];
          created_at?: string;
          ctx?: Json;
          dead_edge_ids?: string[];
          depth?: number;
          last_output?: string;
          level_index?: number;
          run_id: string;
          skipped_node_ids?: string[];
          source?: string;
          suspended_at?: string | null;
          suspended_node_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          completed_node_ids?: string[];
          created_at?: string;
          ctx?: Json;
          dead_edge_ids?: string[];
          depth?: number;
          last_output?: string;
          level_index?: number;
          run_id?: string;
          skipped_node_ids?: string[];
          source?: string;
          suspended_at?: string | null;
          suspended_node_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_run_checkpoints_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: true;
            referencedRelation: "swarm_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_run_edges: {
        Row: {
          bytes: number;
          created_at: string;
          id: string;
          payload_preview: string | null;
          run_id: string;
          source_node_id: string;
          source_step_id: string | null;
          target_node_id: string;
          target_step_id: string | null;
          user_id: string;
        };
        Insert: {
          bytes?: number;
          created_at?: string;
          id?: string;
          payload_preview?: string | null;
          run_id: string;
          source_node_id: string;
          source_step_id?: string | null;
          target_node_id: string;
          target_step_id?: string | null;
          user_id: string;
        };
        Update: {
          bytes?: number;
          created_at?: string;
          id?: string;
          payload_preview?: string | null;
          run_id?: string;
          source_node_id?: string;
          source_step_id?: string | null;
          target_node_id?: string;
          target_step_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_run_edges_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "swarm_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_run_idempotency: {
        Row: {
          api_key_id: string;
          completed_at: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          request_hash: string;
          response: Json | null;
          run_id: string | null;
          status: string;
        };
        Insert: {
          api_key_id: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          request_hash: string;
          response?: Json | null;
          run_id?: string | null;
          status?: string;
        };
        Update: {
          api_key_id?: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          request_hash?: string;
          response?: Json | null;
          run_id?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_run_idempotency_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "swarm_api_keys";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_run_steps: {
        Row: {
          agent_id: string | null;
          cost_usd: number;
          created_at: string;
          data_extractions: Json;
          error_message: string | null;
          finished_at: string | null;
          id: string;
          input: Json;
          latency_ms: number;
          llm_model: string | null;
          llm_provider: string | null;
          memory_used: Json;
          node_id: string;
          node_kind: string;
          node_label: string | null;
          output: string | null;
          parent_step_id: string | null;
          rag_chunks: Json;
          run_id: string;
          started_at: string;
          status: string;
          thinking: string | null;
          tokens_in: number;
          tokens_out: number;
          tool_calls: Json;
          user_id: string;
        };
        Insert: {
          agent_id?: string | null;
          cost_usd?: number;
          created_at?: string;
          data_extractions?: Json;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json;
          latency_ms?: number;
          llm_model?: string | null;
          llm_provider?: string | null;
          memory_used?: Json;
          node_id: string;
          node_kind?: string;
          node_label?: string | null;
          output?: string | null;
          parent_step_id?: string | null;
          rag_chunks?: Json;
          run_id: string;
          started_at?: string;
          status?: string;
          thinking?: string | null;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id: string;
        };
        Update: {
          agent_id?: string | null;
          cost_usd?: number;
          created_at?: string;
          data_extractions?: Json;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json;
          latency_ms?: number;
          llm_model?: string | null;
          llm_provider?: string | null;
          memory_used?: Json;
          node_id?: string;
          node_kind?: string;
          node_label?: string | null;
          output?: string | null;
          parent_step_id?: string | null;
          rag_chunks?: Json;
          run_id?: string;
          started_at?: string;
          status?: string;
          thinking?: string | null;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_run_steps_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "swarm_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_runs: {
        Row: {
          cancel_requested: boolean;
          created_at: string;
          error_count: number;
          error_message: string | null;
          final_output: string | null;
          finished_at: string | null;
          id: string;
          input_prompt: string | null;
          started_at: string;
          status: string;
          step_count: number;
          swarm_id: string | null;
          swarm_name: string | null;
          swarm_snapshot: Json;
          total_cost_usd: number;
          total_latency_ms: number;
          total_tokens_in: number;
          total_tokens_out: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cancel_requested?: boolean;
          created_at?: string;
          error_count?: number;
          error_message?: string | null;
          final_output?: string | null;
          finished_at?: string | null;
          id?: string;
          input_prompt?: string | null;
          started_at?: string;
          status?: string;
          step_count?: number;
          swarm_id?: string | null;
          swarm_name?: string | null;
          swarm_snapshot?: Json;
          total_cost_usd?: number;
          total_latency_ms?: number;
          total_tokens_in?: number;
          total_tokens_out?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cancel_requested?: boolean;
          created_at?: string;
          error_count?: number;
          error_message?: string | null;
          final_output?: string | null;
          finished_at?: string | null;
          id?: string;
          input_prompt?: string | null;
          started_at?: string;
          status?: string;
          step_count?: number;
          swarm_id?: string | null;
          swarm_name?: string | null;
          swarm_snapshot?: Json;
          total_cost_usd?: number;
          total_latency_ms?: number;
          total_tokens_in?: number;
          total_tokens_out?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      swarm_schedules: {
        Row: {
          created_at: string;
          id: string;
          input: string;
          input_state: Json;
          interval_minutes: number;
          is_active: boolean;
          last_run_at: string | null;
          last_run_error: string | null;
          last_run_status: string | null;
          name: string;
          reject_approvals: boolean;
          swarm_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          input?: string;
          input_state?: Json;
          interval_minutes?: number;
          is_active?: boolean;
          last_run_at?: string | null;
          last_run_error?: string | null;
          last_run_status?: string | null;
          name?: string;
          reject_approvals?: boolean;
          swarm_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          input?: string;
          input_state?: Json;
          interval_minutes?: number;
          is_active?: boolean;
          last_run_at?: string | null;
          last_run_error?: string | null;
          last_run_status?: string | null;
          name?: string;
          reject_approvals?: boolean;
          swarm_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_schedules_swarm_id_fkey";
            columns: ["swarm_id"];
            isOneToOne: false;
            referencedRelation: "swarms";
            referencedColumns: ["id"];
          },
        ];
      };
      swarm_versions: {
        Row: {
          created_at: string;
          edges: Json;
          id: string;
          kind: string;
          label: string;
          node_count: number;
          nodes: Json;
          swarm_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          edges?: Json;
          id?: string;
          kind?: string;
          label?: string;
          node_count?: number;
          nodes?: Json;
          swarm_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          edges?: Json;
          id?: string;
          kind?: string;
          label?: string;
          node_count?: number;
          nodes?: Json;
          swarm_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "swarm_versions_swarm_id_fkey";
            columns: ["swarm_id"];
            isOneToOne: false;
            referencedRelation: "swarms";
            referencedColumns: ["id"];
          },
        ];
      };
      swarms: {
        Row: {
          created_at: string;
          description: string | null;
          edges: Json;
          id: string;
          is_deployed: boolean;
          name: string;
          nodes: Json;
          published_at: string | null;
          published_by: string | null;
          published_edges: Json | null;
          published_nodes: Json | null;
          published_version_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          edges?: Json;
          id?: string;
          is_deployed?: boolean;
          name?: string;
          nodes?: Json;
          published_at?: string | null;
          published_by?: string | null;
          published_edges?: Json | null;
          published_nodes?: Json | null;
          published_version_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          edges?: Json;
          id?: string;
          is_deployed?: boolean;
          name?: string;
          nodes?: Json;
          published_at?: string | null;
          published_by?: string | null;
          published_edges?: Json | null;
          published_nodes?: Json | null;
          published_version_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_data_rows: {
        Row: {
          id: number;
          row: Json;
          table_id: string;
        };
        Insert: {
          id?: number;
          row: Json;
          table_id: string;
        };
        Update: {
          id?: number;
          row?: Json;
          table_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_data_rows_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      user_data_semantics: {
        Row: {
          business_name: string | null;
          column_meta: Json;
          created_at: string;
          id: string;
          is_sample: boolean;
          join_hints: Json;
          primary_key: string | null;
          table_description: string | null;
          table_id: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          business_name?: string | null;
          column_meta?: Json;
          created_at?: string;
          id?: string;
          is_sample?: boolean;
          join_hints?: Json;
          primary_key?: string | null;
          table_description?: string | null;
          table_id: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          business_name?: string | null;
          column_meta?: Json;
          created_at?: string;
          id?: string;
          is_sample?: boolean;
          join_hints?: Json;
          primary_key?: string | null;
          table_description?: string | null;
          table_id?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_data_semantics_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      user_data_table_versions: {
        Row: {
          columns: Json;
          created_at: string;
          id: string;
          note: string | null;
          reason: string;
          row_count: number;
          rows: Json | null;
          rows_omitted: boolean;
          table_id: string;
          user_id: string;
        };
        Insert: {
          columns?: Json;
          created_at?: string;
          id?: string;
          note?: string | null;
          reason?: string;
          row_count?: number;
          rows?: Json | null;
          rows_omitted?: boolean;
          table_id: string;
          user_id: string;
        };
        Update: {
          columns?: Json;
          created_at?: string;
          id?: string;
          note?: string | null;
          reason?: string;
          row_count?: number;
          rows?: Json | null;
          rows_omitted?: boolean;
          table_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_data_table_versions_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      user_data_tables: {
        Row: {
          columns: Json;
          created_at: string;
          data_loaded_at: string | null;
          id: string;
          is_sample: boolean;
          name: string;
          parquet_bytes: number | null;
          parquet_last_used_at: string | null;
          parquet_rows: number | null;
          parquet_synced_at: string | null;
          saas_connection_id: string | null;
          saas_stream: string | null;
          source_filename: string | null;
          storage_mode: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          columns?: Json;
          created_at?: string;
          data_loaded_at?: string | null;
          id?: string;
          is_sample?: boolean;
          name: string;
          parquet_bytes?: number | null;
          parquet_last_used_at?: string | null;
          parquet_rows?: number | null;
          parquet_synced_at?: string | null;
          saas_connection_id?: string | null;
          saas_stream?: string | null;
          source_filename?: string | null;
          storage_mode?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          columns?: Json;
          created_at?: string;
          data_loaded_at?: string | null;
          id?: string;
          is_sample?: boolean;
          name?: string;
          parquet_bytes?: number | null;
          parquet_last_used_at?: string | null;
          parquet_rows?: number | null;
          parquet_synced_at?: string | null;
          saas_connection_id?: string | null;
          saas_stream?: string | null;
          source_filename?: string | null;
          storage_mode?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_data_tables_saas_connection_id_fkey";
            columns: ["saas_connection_id"];
            isOneToOne: false;
            referencedRelation: "saas_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      user_prep_flows: {
        Row: {
          config: Json;
          created_at: string;
          id: string;
          last_refresh_at: string | null;
          last_refresh_error: string | null;
          last_run_at: string | null;
          name: string;
          output_table_id: string | null;
          output_table_name: string | null;
          refresh_enabled: boolean;
          refresh_interval_minutes: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          id?: string;
          last_refresh_at?: string | null;
          last_refresh_error?: string | null;
          last_run_at?: string | null;
          name: string;
          output_table_id?: string | null;
          output_table_name?: string | null;
          refresh_enabled?: boolean;
          refresh_interval_minutes?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          id?: string;
          last_refresh_at?: string | null;
          last_refresh_error?: string | null;
          last_run_at?: string | null;
          name?: string;
          output_table_id?: string | null;
          output_table_name?: string | null;
          refresh_enabled?: boolean;
          refresh_interval_minutes?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_prompts: {
        Row: {
          category: string;
          content: string;
          created_at: string;
          description: string | null;
          id: string;
          tags: string[];
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          category?: string;
          content: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          tags?: string[];
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          category?: string;
          content?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          tags?: string[];
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_python_notebooks: {
        Row: {
          cells: Json;
          created_at: string;
          description: string | null;
          id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cells?: Json;
          created_at?: string;
          description?: string | null;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cells?: Json;
          created_at?: string;
          description?: string | null;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          role: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          role: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_saved_metrics: {
        Row: {
          created_at: string;
          description: string | null;
          example_question: string | null;
          id: string;
          name: string;
          sql_expression: string;
          table_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          example_question?: string | null;
          id?: string;
          name: string;
          sql_expression: string;
          table_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          example_question?: string | null;
          id?: string;
          name?: string;
          sql_expression?: string;
          table_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_saved_metrics_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "user_data_tables";
            referencedColumns: ["id"];
          },
        ];
      };
      user_secrets: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
          value: Json;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
          value?: Json;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
          value?: Json;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      admin_spend_by_user: {
        Args: { _since: string };
        Returns: {
          calls: number;
          cost: number;
          tokens: number;
          user_id: string;
        }[];
      };
      audit_chain_verify: {
        Args: never;
        Returns: {
          checked: number;
          first_broken_seq: number;
        }[];
      };
      bi_touch_view: { Args: { _dashboard_id: string }; Returns: undefined };
      budget_spend_since: {
        Args: {
          _scope_id?: string;
          _scope_type?: string;
          _since: string;
          _user_id: string;
          _user_ids?: string[];
        };
        Returns: number;
      };
      can_access_workspace: {
        Args: { uid: string; wid: string };
        Returns: boolean;
      };
      can_use_notebook_runtime: { Args: { uid: string }; Returns: boolean };
      cleanup_old_observability_data: { Args: never; Returns: undefined };
      concurrency_acquire: {
        Args: { _bucket: string; _lease_seconds?: number; _max: number };
        Returns: string;
      };
      concurrency_release: { Args: { _id: string }; Returns: undefined };
      has_resource_access: {
        Args: { rid: string; rtype: string; uid: string };
        Returns: boolean;
      };
      has_unrestricted_resource_access: {
        Args: { rid: string; rtype: string; uid: string };
        Returns: boolean;
      };
      increment_blog_view: { Args: { _slug: string }; Returns: number };
      insert_sample_rows: {
        Args: { _rows: Json; _table_id: string };
        Returns: number;
      };
      is_superadmin: { Args: { uid: string }; Returns: boolean };
      is_swarm_approver: {
        Args: { p_group_ids: string[]; p_user_ids: string[]; uid: string };
        Returns: boolean;
      };
      keyword_kb_chunks: {
        Args: { kb_ids: string[]; match_count?: number; query_text: string };
        Returns: {
          chunk_index: number;
          chunk_kind: string;
          content: string;
          document_id: string;
          id: string;
          knowledge_base_id: string;
          parent_content: string;
          parent_id: string;
          question: string;
          rank: number;
        }[];
      };
      match_kb_chunks: {
        Args: {
          kb_ids: string[];
          match_count?: number;
          query_embedding: string;
        };
        Returns: {
          chunk_index: number;
          content: string;
          document_id: string;
          id: string;
          knowledge_base_id: string;
          similarity: number;
        }[];
      };
      match_kb_chunks_v2: {
        Args: {
          kb_ids: string[];
          match_count?: number;
          query_embedding: string;
        };
        Returns: {
          chunk_index: number;
          chunk_kind: string;
          content: string;
          document_id: string;
          id: string;
          knowledge_base_id: string;
          parent_content: string;
          parent_id: string;
          question: string;
          similarity: number;
        }[];
      };
      prune_agent_memory_items: {
        Args: { _agent_id: string; _max: number; _user_id: string };
        Returns: number;
      };
      rate_limit_sweep: { Args: never; Returns: undefined };
      rate_limit_take: {
        Args: { _bucket: string; _max: number; _window_seconds?: number };
        Returns: boolean;
      };
      seed_bi_sample_dashboards: { Args: { _uid: string }; Returns: undefined };
      seed_bi_sample_extras: { Args: { _uid: string }; Returns: undefined };
      shared_dataset_rows: { Args: { _table_id: string }; Returns: Json[] };
      upsert_sample_dataset: {
        Args: { _columns: Json; _name: string; _source_filename: string };
        Returns: string;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;

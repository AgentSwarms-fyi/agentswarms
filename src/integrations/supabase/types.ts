export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
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
      approvals: {
        Row: {
          action_title: string;
          action_type: string;
          agent_avatar: string | null;
          agent_id: string | null;
          agent_name: string;
          created_at: string;
          decided_at: string | null;
          description: string | null;
          id: string;
          payload: Json;
          risk_level: string;
          status: string;
          user_id: string;
        };
        Insert: {
          action_title: string;
          action_type: string;
          agent_avatar?: string | null;
          agent_id?: string | null;
          agent_name: string;
          created_at?: string;
          decided_at?: string | null;
          description?: string | null;
          id?: string;
          payload?: Json;
          risk_level?: string;
          status?: string;
          user_id: string;
        };
        Update: {
          action_title?: string;
          action_type?: string;
          agent_avatar?: string | null;
          agent_id?: string | null;
          agent_name?: string;
          created_at?: string;
          decided_at?: string | null;
          description?: string | null;
          id?: string;
          payload?: Json;
          risk_level?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      bi_alerts: {
        Row: {
          email_enabled: boolean;
          aggregation: string;
          column_name: string;
          created_at: string;
          dashboard_id: string;
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
          email_enabled?: boolean;
          aggregation?: string;
          column_name?: string;
          created_at?: string;
          dashboard_id: string;
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
          email_enabled?: boolean;
          aggregation?: string;
          column_name?: string;
          created_at?: string;
          dashboard_id?: string;
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
        Relationships: [];
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
          theme?: Json;
          user_id?: string;
          widgets?: Json;
        };
        Relationships: [];
      };
      bi_dashboards: {
        Row: {
          ai_model: string | null;
          created_at: string;
          description: string | null;
          filters: Json;
          id: string;
          last_viewed_at: string | null;
          layout: Json;
          name: string;
          public_slug: string | null;
          published: boolean;
          published_at: string | null;
          theme: Json;
          updated_at: string;
          user_id: string;
          view_count: number;
          widgets: Json;
        };
        Insert: {
          ai_model?: string | null;
          created_at?: string;
          description?: string | null;
          filters?: Json;
          id?: string;
          last_viewed_at?: string | null;
          layout?: Json;
          name: string;
          public_slug?: string | null;
          published?: boolean;
          published_at?: string | null;
          theme?: Json;
          updated_at?: string;
          user_id: string;
          view_count?: number;
          widgets?: Json;
        };
        Update: {
          ai_model?: string | null;
          created_at?: string;
          description?: string | null;
          filters?: Json;
          id?: string;
          last_viewed_at?: string | null;
          layout?: Json;
          name?: string;
          public_slug?: string | null;
          published?: boolean;
          published_at?: string | null;
          theme?: Json;
          updated_at?: string;
          user_id?: string;
          view_count?: number;
          widgets?: Json;
        };
        Relationships: [];
      };
      bi_schedules: {
        Row: {
          email_report: boolean;
          at_hour: number;
          cadence: string;
          created_at: string;
          dashboard_id: string;
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
          email_report?: boolean;
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          dashboard_id: string;
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
          email_report?: boolean;
          at_hour?: number;
          cadence?: string;
          created_at?: string;
          dashboard_id?: string;
          enabled?: boolean;
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          last_status?: string | null;
          next_run_at?: string;
          user_id?: string;
          weekday?: number;
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
        Relationships: [];
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
      certificates: {
        Row: {
          agent_score: number;
          attempt_id: string;
          created_at: string;
          id: string;
          issued_at: string;
          mcq_score: number;
          name_on_cert: string;
          organization: string | null;
          swarm_score: number;
          user_id: string;
          verification_code: string;
        };
        Insert: {
          agent_score: number;
          attempt_id: string;
          created_at?: string;
          id?: string;
          issued_at?: string;
          mcq_score: number;
          name_on_cert: string;
          organization?: string | null;
          swarm_score: number;
          user_id: string;
          verification_code: string;
        };
        Update: {
          agent_score?: number;
          attempt_id?: string;
          created_at?: string;
          id?: string;
          issued_at?: string;
          mcq_score?: number;
          name_on_cert?: string;
          organization?: string | null;
          swarm_score?: number;
          user_id?: string;
          verification_code?: string;
        };
        Relationships: [
          {
            foreignKeyName: "certificates_attempt_id_fkey";
            columns: ["attempt_id"];
            isOneToOne: false;
            referencedRelation: "exam_attempts";
            referencedColumns: ["id"];
          },
        ];
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
      embed_keys: {
        Row: {
          allow_ai: boolean;
          allowed_domains: string[];
          created_at: string;
          id: string;
          is_active: boolean;
          key: string;
          last_used_at: string | null;
          name: string;
          resource_id: string;
          resource_type: string;
          updated_at: string;
          use_count: number;
          user_id: string;
        };
        Insert: {
          allow_ai?: boolean;
          allowed_domains?: string[];
          created_at?: string;
          id?: string;
          is_active?: boolean;
          key: string;
          last_used_at?: string | null;
          name: string;
          resource_id: string;
          resource_type: string;
          updated_at?: string;
          use_count?: number;
          user_id: string;
        };
        Update: {
          allow_ai?: boolean;
          allowed_domains?: string[];
          created_at?: string;
          id?: string;
          is_active?: boolean;
          key?: string;
          last_used_at?: string | null;
          name?: string;
          resource_id?: string;
          resource_type?: string;
          updated_at?: string;
          use_count?: number;
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
      exam_attempts: {
        Row: {
          agent_eval: Json;
          created_at: string;
          evaluator_feedback: string | null;
          id: string;
          improvement_areas: Json;
          mcq_answers: Json;
          mcq_score: number;
          mcq_total: number;
          next_eligible_at: string | null;
          selected_agent_ids: string[];
          selected_swarm_ids: string[];
          set_id: string;
          started_at: string;
          status: string;
          submitted_at: string | null;
          swarm_eval: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          agent_eval?: Json;
          created_at?: string;
          evaluator_feedback?: string | null;
          id?: string;
          improvement_areas?: Json;
          mcq_answers?: Json;
          mcq_score?: number;
          mcq_total?: number;
          next_eligible_at?: string | null;
          selected_agent_ids?: string[];
          selected_swarm_ids?: string[];
          set_id: string;
          started_at?: string;
          status?: string;
          submitted_at?: string | null;
          swarm_eval?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          agent_eval?: Json;
          created_at?: string;
          evaluator_feedback?: string | null;
          id?: string;
          improvement_areas?: Json;
          mcq_answers?: Json;
          mcq_score?: number;
          mcq_total?: number;
          next_eligible_at?: string | null;
          selected_agent_ids?: string[];
          selected_swarm_ids?: string[];
          set_id?: string;
          started_at?: string;
          status?: string;
          submitted_at?: string | null;
          swarm_eval?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "exam_attempts_set_id_fkey";
            columns: ["set_id"];
            isOneToOne: false;
            referencedRelation: "exam_question_sets";
            referencedColumns: ["id"];
          },
        ];
      };
      exam_question_sets: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          is_seed: boolean;
          questions: Json;
          week_label: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_seed?: boolean;
          questions?: Json;
          week_label: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_seed?: boolean;
          questions?: Json;
          week_label?: string;
        };
        Relationships: [];
      };
      execution_traces: {
        Row: {
          agent_id: string | null;
          agent_name: string;
          cost_usd: number;
          created_at: string;
          error_message: string | null;
          id: string;
          latency_ms: number;
          llm_model: string;
          llm_provider: string;
          prompt: string | null;
          request_payload: Json;
          response_payload: Json;
          status: string;
          tokens_in: number;
          tokens_out: number;
          tool_calls: Json;
          user_id: string;
        };
        Insert: {
          agent_id?: string | null;
          agent_name: string;
          cost_usd?: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          latency_ms?: number;
          llm_model: string;
          llm_provider?: string;
          prompt?: string | null;
          request_payload?: Json;
          response_payload?: Json;
          status?: string;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id: string;
        };
        Update: {
          agent_id?: string | null;
          agent_name?: string;
          cost_usd?: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          latency_ms?: number;
          llm_model?: string;
          llm_provider?: string;
          prompt?: string | null;
          request_payload?: Json;
          response_payload?: Json;
          status?: string;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: Json;
          user_id?: string;
        };
        Relationships: [];
      };
      data_warehouse_connections: {
        Row: {
          created_at: string;
          credentials: Json;
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
          id: boolean;
          sso_enabled: boolean;
          sso_enforced: boolean;
          updated_at: string;
        };
        Insert: {
          allow_public_signup?: boolean;
          id?: boolean;
          sso_enabled?: boolean;
          sso_enforced?: boolean;
          updated_at?: string;
        };
        Update: {
          allow_public_signup?: boolean;
          id?: boolean;
          sso_enabled?: boolean;
          sso_enforced?: boolean;
          updated_at?: string;
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
      kb_chunks: {
        Row: {
          chunk_index: number;
          content: string;
          created_at: string;
          document_id: string;
          embedding: string;
          id: string;
          is_sample: boolean;
          knowledge_base_id: string;
          token_estimate: number | null;
          user_id: string;
        };
        Insert: {
          chunk_index: number;
          content: string;
          created_at?: string;
          document_id: string;
          embedding: string;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id: string;
          token_estimate?: number | null;
          user_id: string;
        };
        Update: {
          chunk_index?: number;
          content?: string;
          created_at?: string;
          document_id?: string;
          embedding?: string;
          id?: string;
          is_sample?: boolean;
          knowledge_base_id?: string;
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
          config: Json;
          created_at: string;
          error: string | null;
          id: string;
          is_sample: boolean;
          kind: string;
          knowledge_base_id: string;
          label: string | null;
          last_synced_at: string | null;
          status: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          error?: string | null;
          id?: string;
          is_sample?: boolean;
          kind: string;
          knowledge_base_id: string;
          label?: string | null;
          last_synced_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          config?: Json;
          created_at?: string;
          error?: string | null;
          id?: string;
          is_sample?: boolean;
          kind?: string;
          knowledge_base_id?: string;
          label?: string | null;
          last_synced_at?: string | null;
          status?: string;
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
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      knowledge_documents: {
        Row: {
          content: string | null;
          created_at: string;
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
          content?: string | null;
          created_at?: string;
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
          content?: string | null;
          created_at?: string;
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
      mcp_servers: {
        Row: {
          auth_token: string | null;
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
      quiz_attempts: {
        Row: {
          answers: Json;
          created_at: string;
          id: string;
          passed: boolean;
          score: number;
          total: number;
          track_id: string;
          user_id: string;
        };
        Insert: {
          answers?: Json;
          created_at?: string;
          id?: string;
          passed?: boolean;
          score?: number;
          total?: number;
          track_id: string;
          user_id: string;
        };
        Update: {
          answers?: Json;
          created_at?: string;
          id?: string;
          passed?: boolean;
          score?: number;
          total?: number;
          track_id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      quiz_questions: {
        Row: {
          correct_index: number;
          created_at: string;
          difficulty: string;
          explanation: string | null;
          id: string;
          options: Json;
          position: number;
          question: string;
          track_id: string;
        };
        Insert: {
          correct_index: number;
          created_at?: string;
          difficulty?: string;
          explanation?: string | null;
          id?: string;
          options?: Json;
          position?: number;
          question: string;
          track_id: string;
        };
        Update: {
          correct_index?: number;
          created_at?: string;
          difficulty?: string;
          explanation?: string | null;
          id?: string;
          options?: Json;
          position?: number;
          question?: string;
          track_id?: string;
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
      swarms: {
        Row: {
          created_at: string;
          description: string | null;
          edges: Json;
          id: string;
          is_deployed: boolean;
          name: string;
          nodes: Json;
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
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_announcements_dismissed: {
        Row: {
          announcement_key: string;
          dismissed_at: string;
          user_id: string;
        };
        Insert: {
          announcement_key: string;
          dismissed_at?: string;
          user_id: string;
        };
        Update: {
          announcement_key?: string;
          dismissed_at?: string;
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
      user_data_tables: {
        Row: {
          columns: Json;
          created_at: string;
          id: string;
          is_sample: boolean;
          name: string;
          source_filename: string | null;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          columns?: Json;
          created_at?: string;
          id?: string;
          is_sample?: boolean;
          name: string;
          source_filename?: string | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          columns?: Json;
          created_at?: string;
          id?: string;
          is_sample?: boolean;
          name?: string;
          source_filename?: string | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      user_prep_flows: {
        Row: {
          config: Json;
          created_at: string;
          id: string;
          last_run_at: string | null;
          name: string;
          output_table_id: string | null;
          output_table_name: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          id?: string;
          last_run_at?: string | null;
          name: string;
          output_table_id?: string | null;
          output_table_name?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          id?: string;
          last_run_at?: string | null;
          name?: string;
          output_table_id?: string | null;
          output_table_name?: string | null;
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
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      bi_touch_view: {
        Args: { _dashboard_id: string };
        Returns: undefined;
      };
      cleanup_old_observability_data: { Args: never; Returns: undefined };
      has_resource_access: {
        Args: { rtype: string; rid: string; uid: string };
        Returns: boolean;
      };
      is_superadmin: {
        Args: { uid: string };
        Returns: boolean;
      };
      insert_sample_rows: {
        Args: { _rows: Json; _table_id: string };
        Returns: number;
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
      prune_agent_memory_items: {
        Args: { _agent_id: string; _max: number; _user_id: string };
        Returns: number;
      };
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
  public: {
    Enums: {},
  },
} as const;

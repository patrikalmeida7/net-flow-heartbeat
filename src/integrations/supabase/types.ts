export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alertas: {
        Row: {
          concentrador_id: string | null
          created_at: string
          descricao: string | null
          id: string
          rbs_id: string | null
          reconhecido_em: string | null
          reconhecido_por: string | null
          resolvido_em: string | null
          severidade: Database["public"]["Enums"]["alert_severity"]
          status: Database["public"]["Enums"]["alert_status"]
          titulo: string
        }
        Insert: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          rbs_id?: string | null
          reconhecido_em?: string | null
          reconhecido_por?: string | null
          resolvido_em?: string | null
          severidade?: Database["public"]["Enums"]["alert_severity"]
          status?: Database["public"]["Enums"]["alert_status"]
          titulo: string
        }
        Update: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          rbs_id?: string | null
          reconhecido_em?: string | null
          reconhecido_por?: string | null
          resolvido_em?: string | null
          severidade?: Database["public"]["Enums"]["alert_severity"]
          status?: Database["public"]["Enums"]["alert_status"]
          titulo?: string
        }
        Relationships: [
          {
            foreignKeyName: "alertas_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alertas_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      concentradores: {
        Row: {
          cpu_load: number | null
          created_at: string
          host: string
          id: string
          identidade: string | null
          memory_used_pct: number | null
          modelo: string | null
          nome: string
          observacoes: string | null
          status: Database["public"]["Enums"]["device_status"]
          ultima_coleta: string | null
          updated_at: string
          uptime_seconds: number | null
          usuarios_online: number
          versao_routeros: string | null
        }
        Insert: {
          cpu_load?: number | null
          created_at?: string
          host: string
          id?: string
          identidade?: string | null
          memory_used_pct?: number | null
          modelo?: string | null
          nome: string
          observacoes?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uptime_seconds?: number | null
          usuarios_online?: number
          versao_routeros?: string | null
        }
        Update: {
          cpu_load?: number | null
          created_at?: string
          host?: string
          id?: string
          identidade?: string | null
          memory_used_pct?: number | null
          modelo?: string | null
          nome?: string
          observacoes?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uptime_seconds?: number | null
          usuarios_online?: number
          versao_routeros?: string | null
        }
        Relationships: []
      }
      eventos: {
        Row: {
          concentrador_id: string | null
          created_at: string
          descricao: string | null
          id: string
          metadata: Json | null
          rbs_id: string | null
          tipo: Database["public"]["Enums"]["event_type"]
          username: string | null
        }
        Insert: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          rbs_id?: string | null
          tipo: Database["public"]["Enums"]["event_type"]
          username?: string | null
        }
        Update: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          rbs_id?: string | null
          tipo?: Database["public"]["Enums"]["event_type"]
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eventos_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eventos_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      pppoe_sessions: {
        Row: {
          bytes_in: number | null
          bytes_out: number | null
          caller_id: string | null
          concentrador_id: string | null
          conectado_em: string
          desconectado_em: string | null
          id: string
          interface: string | null
          ip_address: string | null
          online: boolean
          ultima_atualizacao: string
          uptime_seconds: number | null
          username: string
        }
        Insert: {
          bytes_in?: number | null
          bytes_out?: number | null
          caller_id?: string | null
          concentrador_id?: string | null
          conectado_em?: string
          desconectado_em?: string | null
          id?: string
          interface?: string | null
          ip_address?: string | null
          online?: boolean
          ultima_atualizacao?: string
          uptime_seconds?: number | null
          username: string
        }
        Update: {
          bytes_in?: number | null
          bytes_out?: number | null
          caller_id?: string | null
          concentrador_id?: string | null
          conectado_em?: string
          desconectado_em?: string | null
          id?: string
          interface?: string | null
          ip_address?: string | null
          online?: boolean
          ultima_atualizacao?: string
          uptime_seconds?: number | null
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "pppoe_sessions_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rbs: {
        Row: {
          created_at: string
          endereco: string | null
          host: string | null
          id: string
          latitude: number | null
          longitude: number | null
          nome: string
          observacoes: string | null
          perda_pct: number | null
          ping_ms: number | null
          status: Database["public"]["Enums"]["device_status"]
          ultima_coleta: string | null
          updated_at: string
          uso_banda_mbps: number | null
        }
        Insert: {
          created_at?: string
          endereco?: string | null
          host?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          nome: string
          observacoes?: string | null
          perda_pct?: number | null
          ping_ms?: number | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uso_banda_mbps?: number | null
        }
        Update: {
          created_at?: string
          endereco?: string | null
          host?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          nome?: string
          observacoes?: string | null
          perda_pct?: number | null
          ping_ms?: number | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uso_banda_mbps?: number | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      alert_severity: "info" | "warning" | "critical"
      alert_status: "active" | "acknowledged" | "resolved"
      app_role: "admin" | "tecnico" | "visualizador"
      device_status: "online" | "warning" | "offline" | "unknown"
      event_type:
        | "connect"
        | "disconnect"
        | "device_down"
        | "device_up"
        | "rbs_down"
        | "rbs_up"
        | "flapping"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      alert_severity: ["info", "warning", "critical"],
      alert_status: ["active", "acknowledged", "resolved"],
      app_role: ["admin", "tecnico", "visualizador"],
      device_status: ["online", "warning", "offline", "unknown"],
      event_type: [
        "connect",
        "disconnect",
        "device_down",
        "device_up",
        "rbs_down",
        "rbs_up",
        "flapping",
      ],
    },
  },
} as const

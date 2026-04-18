import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Radio, Server, Users } from "lucide-react";
import AdminConcentradores from "./admin/AdminConcentradores";
import AdminRBS from "./admin/AdminRBS";
import AdminUsuarios from "./admin/AdminUsuarios";

export default function Admin() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Administração</h1>
        <p className="text-sm text-muted-foreground">
          Gerencie concentradores, RBS e papéis de usuários. Acesso restrito a administradores.
        </p>
      </div>

      <Tabs defaultValue="concentradores" className="space-y-4">
        <TabsList>
          <TabsTrigger value="concentradores" className="gap-2">
            <Server className="h-4 w-4" /> Concentradores
          </TabsTrigger>
          <TabsTrigger value="rbs" className="gap-2">
            <Radio className="h-4 w-4" /> RBS / Torres
          </TabsTrigger>
          <TabsTrigger value="usuarios" className="gap-2">
            <Users className="h-4 w-4" /> Usuários
          </TabsTrigger>
        </TabsList>
        <TabsContent value="concentradores"><AdminConcentradores /></TabsContent>
        <TabsContent value="rbs"><AdminRBS /></TabsContent>
        <TabsContent value="usuarios"><AdminUsuarios /></TabsContent>
      </Tabs>
    </div>
  );
}

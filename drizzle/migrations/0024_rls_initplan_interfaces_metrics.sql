-- Same predicates, evaluated once per query (initPlan) instead of once per row.
ALTER POLICY admins_manage_interfaces ON public.device_interfaces
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));
ALTER POLICY auth_view_interfaces ON public.device_interfaces
  USING ((SELECT public.is_authorized((SELECT auth.uid()))));
ALTER POLICY auth_view_metric_samples ON public.metric_samples
  USING ((SELECT public.is_authorized((SELECT auth.uid()))));
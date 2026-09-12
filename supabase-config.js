/* Public by design: the security boundary is Row Level Security, not this file.
   Fill both values in from Supabase -> Project Settings -> API.
   Use the publishable key (sb_publishable_...), not the legacy anon JWT.
   While these are still placeholders, the app runs local-only. */
window.IRONVIM_SUPABASE = {
  url: "https://yvaopzdqindojyubudaj.supabase.co",
  publishableKey: "sb_publishable_2it8-wqle1j08AvGtNBZgQ_R9UVbxxp",
};

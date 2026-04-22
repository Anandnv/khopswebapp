window.KH_CONFIG = {
  supabaseUrl: "https://klejoohjzdivuxgdvycm.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsZWpvb2hqemRpdnV4Z2R2eWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NjMyMjUsImV4cCI6MjA5MjMzOTIyNX0.euV8xftFlkqcljRFwN6TeTbar5U-_c-o9G8VaaWurdU",
  // SHA-256 of the admin password. Change this hash when you change the password.
  // To generate: open browser console and run:
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
  //     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
  adminPasswordHash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9"
};

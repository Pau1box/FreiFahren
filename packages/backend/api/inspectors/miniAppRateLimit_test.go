package inspectors

import (
	"sync"
	"testing"
	"time"
)

// Two reports for the same city arriving together must produce one notification, not two. Before
// the claim moved inside the lock, both would find the interval passed, because the claim only
// happened after the HTTP call to the mini app.
func TestMiniAppRateLimitClaimsOnceUnderConcurrency(t *testing.T) {
	limiter := &miniAppRateLimit{last: make(map[string]time.Time)}

	const attempts = 50
	var allowedCount int
	var counter sync.Mutex
	var group sync.WaitGroup

	for attempt := 0; attempt < attempts; attempt++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, _, allowed := limiter.reserve("berlin"); allowed {
				counter.Lock()
				allowedCount++
				counter.Unlock()
			}
		}()
	}
	group.Wait()

	if allowedCount != 1 {
		t.Errorf("%d of %d concurrent reports were allowed to notify, want 1", allowedCount, attempts)
	}
}

// One city's reports must not silence another city's chat. Every network has its own Telegram chat.
func TestMiniAppRateLimitIsPerNetwork(t *testing.T) {
	limiter := &miniAppRateLimit{last: make(map[string]time.Time)}

	if _, _, allowed := limiter.reserve("berlin"); !allowed {
		t.Fatal("the first notification for berlin was refused")
	}
	if _, _, allowed := limiter.reserve("munich"); !allowed {
		t.Error("berlin's notification silenced munich")
	}
	if _, _, allowed := limiter.reserve("berlin"); allowed {
		t.Error("berlin was allowed a second notification straight away")
	}
}

// A notification that could not be delivered must not cost the network its next five minutes.
func TestMiniAppRateLimitReleaseRestoresTheSlot(t *testing.T) {
	limiter := &miniAppRateLimit{last: make(map[string]time.Time)}

	previous, claimed, allowed := limiter.reserve("berlin")
	if !allowed {
		t.Fatal("the first notification for berlin was refused")
	}
	limiter.release("berlin", previous, claimed)

	if _, _, allowed := limiter.reserve("berlin"); !allowed {
		t.Error("a failed notification still consumed the interval")
	}
}

// Releasing must not undo a claim someone else has since made, or a failing send would reopen the
// gate for a notification that did go out.
func TestMiniAppRateLimitReleaseLeavesANewerClaimAlone(t *testing.T) {
	limiter := &miniAppRateLimit{last: make(map[string]time.Time)}

	previous, claimed, _ := limiter.reserve("berlin")
	limiter.last["berlin"] = time.Now() // as a later, successful notification would
	limiter.release("berlin", previous, claimed)

	if _, _, allowed := limiter.reserve("berlin"); allowed {
		t.Error("releasing an old claim reopened the gate on a newer one")
	}
}

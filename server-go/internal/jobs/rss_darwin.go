//go:build darwin

package jobs

/*
#include <mach/mach.h>
#include <mach/task.h>
*/
import "C"

import "unsafe"

// processRSSBytes returns the current resident set size of this process via the
// Mach task_info(MACH_TASK_BASIC_INFO) resident_size — the darwin analogue of
// Node's process.memoryUsage().rss (and what ps reports as RSS). Unlike
// runtime.MemStats.Sys it includes cgo/SQLite malloc + mmap pages. ok=false on
// failure so the caller can fall back.
func processRSSBytes() (uint64, bool) {
	var info C.mach_task_basic_info_data_t
	count := C.mach_msg_type_number_t(C.MACH_TASK_BASIC_INFO_COUNT)
	kr := C.task_info(
		C.task_name_t(C.mach_task_self_),
		C.task_flavor_t(C.MACH_TASK_BASIC_INFO),
		C.task_info_t(unsafe.Pointer(&info)),
		&count,
	)
	if kr != C.KERN_SUCCESS {
		return 0, false
	}
	return uint64(info.resident_size), true
}
